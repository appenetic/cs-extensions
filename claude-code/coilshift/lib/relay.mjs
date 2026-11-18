// The relay for a car that cannot reach this Mac directly, with no shared WLAN
// and no Tailscale: both sides connect out to a public MQTT broker and trade
// end-to-end encrypted messages on topics derived from a pairing secret. The
// broker sees ciphertext under random topic names and nothing else.
//
// The car's side is services/claude/relay.go; the two must agree on every byte:
//   channel   base = HMAC-SHA256(key "coilshift-claude relay <kind> v1", secret)
//             topic id = hex(HMAC(base, "topic"))[:32], keys HMAC(base, "up"|"down")
//             topics cs-claude/v1/<id>/up (car to Mac) and /down (Mac to car)
//   message   nonce(12) | AES-256-GCM(raw deflate of the JSON, AAD = topic)
//   part      0x01 | message id(8) | index(u16) | count(u16) | up to 32 KiB
//
// Pairing through the relay never trusts what a reader of the car's screen or
// of a pairing link could know. The code the car shows commits to an X25519
// key of the car; the Mac seals its offer to that key, and the bridge seals the
// token and relay key of a pairing to the key the car sends with /v1/pair.
import crypto from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'

export const DEFAULT_BROKERS = ['broker.emqx.io:8883', 'broker.hivemq.com:8883']
export const CHUNK = 32 * 1024
const MAX_PARTS = 64
const MAX_PACKET = 256 * 1024
const MAX_PLAIN = 8 << 20
const CLOCK_SKEW = 10 * 60 * 1000
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

export function channel(kind, secret) {
  const base = hmac(`coilshift-claude relay ${kind} v1`, secret)
  const id = hmac(base, 'topic').toString('hex').slice(0, 32)
  return { id, up: `cs-claude/v1/${id}/up`, down: `cs-claude/v1/${id}/down`, kUp: hmac(base, 'up'), kDown: hmac(base, 'down') }
}

export const OFFER_LABEL = 'coilshift-claude offer v1'
export const ANSWER_LABEL = 'coilshift-claude pair answer v1'

export const boxKeys = () => crypto.generateKeyPairSync('x25519')
export const rawPublic = (key) => Buffer.from(key.export({ format: 'jwk' }).x, 'base64url')

// boxKey is the key for messages between an X25519 private key and a peer's
// raw public key; it throws for anything but a usable 32-byte key.
export function boxKey(privateKey, peer, label) {
  if (!Buffer.isBuffer(peer) || peer.length !== 32) throw new Error('invalid key')
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: peer.toString('base64url') }, format: 'jwk' })
  return hmac(crypto.diffieHellman({ privateKey, publicKey }), label)
}

function crockford(bytes) {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  return out
}

// carCodeFor is the code the car shows for its pairing key: 80 bits of its
// hash, so nobody can bring another key that fits the code.
export function carCodeFor(pub) {
  return crockford(crypto.createHash('sha256').update('coilshift-claude car code v1').update(pub).digest().subarray(0, 10))
}

export function seal(key, topic, value) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(topic))
  const body = Buffer.concat([cipher.update(zlib.deflateRawSync(Buffer.from(JSON.stringify(value)))), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

// open throws for anything that was not sealed with key for topic.
export function open(key, topic, blob) {
  if (blob.length < 12 + 16) throw new Error('short message')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
  decipher.setAAD(Buffer.from(topic))
  decipher.setAuthTag(blob.subarray(blob.length - 16))
  const plain = Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()])
  return JSON.parse(zlib.inflateRawSync(plain, { maxOutputLength: MAX_PLAIN }).toString('utf8'))
}

// Public brokers cap a message somewhere above 64 KiB, so a long answer travels
// in parts.
export function chunks(blob) {
  const count = Math.max(1, Math.ceil(blob.length / CHUNK))
  if (count > MAX_PARTS) throw new Error('message too large')
  const id = crypto.randomBytes(8)
  const parts = []
  for (let i = 0; i < count; i++) {
    const head = Buffer.alloc(13)
    head[0] = 1
    id.copy(head, 1)
    head.writeUInt16BE(i, 9)
    head.writeUInt16BE(count, 11)
    parts.push(Buffer.concat([head, blob.subarray(i * CHUNK, (i + 1) * CHUNK)]))
  }
  return parts
}

export class Assembler {
  constructor(now = Date.now) {
    this.now = now
    this.open = new Map()
  }

  // add answers the whole message once its last part is in.
  add(key, part) {
    if (part.length < 13 || part[0] !== 1) return null
    const index = part.readUInt16BE(9)
    const count = part.readUInt16BE(11)
    if (count < 1 || count > MAX_PARTS || index >= count) return null
    if (count === 1) return part.subarray(13)
    for (const [k, entry] of this.open) if (this.now() - entry.at > 60000) this.open.delete(k)
    const id = key + ' ' + part.subarray(1, 9).toString('hex')
    let entry = this.open.get(id)
    if (!entry) {
      if (this.open.size >= 32) return null
      entry = { at: this.now(), count, got: 0, parts: new Array(count) }
      this.open.set(id, entry)
    }
    if (entry.count !== count || entry.parts[index]) return null
    entry.parts[index] = Buffer.from(part.subarray(13))
    if (++entry.got < count) return null
    this.open.delete(id)
    return Buffer.concat(entry.parts)
  }
}

// carCode reads the code the car shows, typed with or without dashes and with
// I, L and O for 1 and 0.
export function carCode(input) {
  const code = String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(code) && [...code].every((c) => CROCKFORD.includes(c)) ? code : ''
}

// COILSHIFT_RELAY lists brokers as host[:port] (TLS, port 8883 by default) or
// turns the relay off with "off".
export function relayBrokers(env = process.env) {
  const raw = String(env.COILSHIFT_RELAY || '').trim().toLowerCase()
  if (/^(off|aus|no|false|0)$/.test(raw)) return []
  const list = raw ? raw.split(',') : DEFAULT_BROKERS
  return [...new Set(list.map((s) => normalizeBroker(s.trim())).filter(Boolean))].slice(0, 4)
}

export function normalizeBroker(spec) {
  const m = /^([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)(?::(\d{1,5}))?$/.exec(String(spec || '').toLowerCase())
  if (!m) return ''
  const port = Number(m[3] || 8883)
  return port >= 1 && port <= 65535 ? `${m[1]}:${port}` : ''
}

// Brokers speak TLS against the system's roots. COILSHIFT_RELAY_PLAIN=1 allows
// plain TCP to a loopback broker, for tests.
export function dialBroker(broker, env = process.env) {
  const [host, port] = [broker.slice(0, broker.lastIndexOf(':')), Number(broker.slice(broker.lastIndexOf(':') + 1))]
  if (env.COILSHIFT_RELAY_PLAIN === '1' && ['127.0.0.1', 'localhost'].includes(host)) {
    return { socket: net.connect({ host, port }), ready: 'connect' }
  }
  return { socket: tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' }), ready: 'secureConnect' }
}

// ---------------------------------------------------------------- MQTT 3.1.1

const u16 = (n) => Buffer.from([(n >> 8) & 255, n & 255])
const mqttString = (s) => {
  const b = Buffer.from(s)
  return Buffer.concat([u16(b.length), b])
}
function remainingLength(n) {
  const out = []
  do {
    let digit = n % 128
    n = Math.floor(n / 128)
    if (n > 0) digit |= 128
    out.push(digit)
  } while (n > 0)
  return Buffer.from(out)
}
export const packet = (header, body = Buffer.alloc(0)) => Buffer.concat([Buffer.from([header]), remainingLength(body.length), body])

// readPacket answers the first whole packet in buffer, or null when more bytes
// are needed.
export function readPacket(buffer) {
  let length = 0
  for (let i = 1; i <= 4; i++) {
    if (i >= buffer.length) return null
    length += (buffer[i] & 127) * 128 ** (i - 1)
    if (buffer[i] & 128) continue
    if (length > MAX_PACKET) throw new Error('packet too large')
    if (buffer.length < i + 1 + length) return null
    return { type: buffer[0] >> 4, flags: buffer[0] & 15, body: buffer.subarray(i + 1, i + 1 + length), size: i + 1 + length }
  }
  throw new Error('malformed packet')
}

// MqttClient is the smallest client the relay needs: one broker, clean
// sessions, QoS 0, subscriptions restored after every reconnect.
export class MqttClient {
  constructor(broker, options = {}) {
    this.broker = broker
    this.dial = options.dial || dialBroker
    this.onMessage = options.onMessage || (() => {})
    this.onChange = options.onChange || (() => {})
    this.onUp = options.onUp || (() => {})
    this.topics = new Set()
    this.state = 'idle'
    this.error = ''
    this.running = false
    this.nextId = 0
    this.delay = 1000
  }

  start() {
    if (this.running) return
    this.running = true
    this.connect()
  }

  stop() {
    this.running = false
    clearTimeout(this.retry)
    if (this.socket) this.socket.destroy()
    this.set('idle', '')
  }

  set(state, error = this.error) {
    if (state === this.state && error === this.error) return
    this.state = state
    this.error = error
    this.onChange(this)
  }

  id() {
    this.nextId = (this.nextId % 65535) + 1
    return u16(this.nextId)
  }

  connect() {
    this.set('connecting')
    let socket
    try {
      const dialed = this.dial(this.broker)
      socket = dialed.socket
      socket.once(dialed.ready, () => {
        const clientId = 'csb-' + crypto.randomBytes(6).toString('hex')
        socket.write(packet(0x10, Buffer.concat([mqttString('MQTT'), Buffer.from([4, 0x02, 0, 60]), mqttString(clientId)])))
      })
    } catch (error) {
      return this.lost(error)
    }
    this.socket = socket
    let buffer = Buffer.alloc(0)
    let heard = Date.now()
    let pinger = null
    const connack = setTimeout(() => socket.destroy(new Error('no answer from the broker')), 20000)
    socket.on('data', (data) => {
      heard = Date.now()
      buffer = buffer.length ? Buffer.concat([buffer, data]) : data
      try {
        for (let p = readPacket(buffer); p; p = readPacket(buffer)) {
          buffer = buffer.subarray(p.size)
          if (p.type === 2) {
            clearTimeout(connack)
            if (p.body[1] !== 0) return socket.destroy(new Error(`broker refused (${p.body[1]})`))
            this.delay = 1000
            this.set('up', '')
            for (const topic of this.topics) socket.write(packet(0x82, Buffer.concat([this.id(), mqttString(topic), Buffer.from([0])])))
            this.onUp(this)
            pinger = setInterval(() => {
              if (Date.now() - heard > 75000) socket.destroy(new Error('broker silent'))
              else socket.write(packet(0xc0))
            }, 25000)
          } else if (p.type === 3) {
            const length = p.body.readUInt16BE(0)
            const topic = p.body.subarray(2, 2 + length).toString('utf8')
            let payload = p.body.subarray(2 + length)
            const qos = (p.flags >> 1) & 3
            if (qos > 0) {
              if (qos === 1) socket.write(packet(0x40, payload.subarray(0, 2)))
              payload = payload.subarray(2)
            }
            this.onMessage(topic, payload, this)
          }
        }
      } catch (error) {
        socket.destroy(error)
      }
    })
    socket.on('error', (error) => {
      this.error = error.code || error.message
    })
    socket.on('close', () => {
      clearTimeout(connack)
      clearInterval(pinger)
      if (this.socket === socket) this.lost()
    })
  }

  lost(error) {
    this.socket = null
    if (!this.running) return
    this.set('down', error ? error.code || error.message : this.error || 'closed')
    this.retry = setTimeout(() => this.connect(), this.delay)
    this.retry.unref?.()
    this.delay = Math.min(this.delay * 2, 60000)
  }

  subscribe(topic) {
    if (this.topics.has(topic)) return
    this.topics.add(topic)
    if (this.state === 'up') this.socket.write(packet(0x82, Buffer.concat([this.id(), mqttString(topic), Buffer.from([0])])))
  }

  unsubscribe(topic) {
    if (!this.topics.delete(topic)) return
    if (this.state === 'up') this.socket.write(packet(0xa2, Buffer.concat([this.id(), mqttString(topic)])))
  }

  publish(topic, payload) {
    if (this.state !== 'up' || !this.socket) return false
    this.socket.write(packet(0x30, Buffer.concat([mqttString(topic), payload])))
    return true
  }
}

// ---------------------------------------------------------------- the Mac's side

// Relay keeps this Mac reachable through every configured broker at once; the
// car uses whichever it reaches and gets its answer on the same broker.
export class Relay {
  constructor({ brokers, handle, dial, log = () => {}, now = Date.now }) {
    this.handle = handle
    this.log = log
    this.now = now
    this.channels = new Map()
    this.seen = new Map()
    this.assembler = new Assembler(now)
    this.clients = brokers.map(
      (broker) =>
        new MqttClient(broker, {
          dial,
          onMessage: (topic, payload, client) => this.receive(client, topic, payload),
          onChange: (client) => log(`relay ${client.broker}: ${client.state}${client.error ? ' (' + client.error + ')' : ''}`),
          onUp: (client) => this.announce(client),
        }),
    )
  }

  add(name, ch, info = {}) {
    this.remove(name)
    this.channels.set(ch.up, { name, ch, info })
    for (const client of this.clients) {
      client.subscribe(ch.up)
      client.start()
    }
  }

  remove(name) {
    for (const [topic, entry] of this.channels) {
      if (entry.name !== name) continue
      this.channels.delete(topic)
      for (const client of this.clients) client.unsubscribe(topic)
    }
  }

  stop() {
    for (const client of this.clients) client.stop()
  }

  status() {
    return this.clients.map((c) => ({ broker: c.broker, state: c.state, error: c.error }))
  }

  // Requests are fresh (ten minutes of clock skew allowed) and answered once:
  // a replayed /v1/reply or /v1/start must not act twice.
  receive(client, topic, payload) {
    const entry = this.channels.get(topic)
    if (!entry) return
    const blob = this.assembler.add(client.broker + ' ' + topic, payload)
    if (!blob) return
    let request
    try {
      request = open(entry.ch.kUp, topic, blob)
    } catch {
      return
    }
    // A pairing by the car's code talks in messages, not requests.
    if (entry.info.onMessage) return entry.info.onMessage(request, client)
    const now = this.now()
    if (!request || typeof request.id !== 'string' || !/^[0-9a-f]{32}$/.test(request.id)) return
    if (!Number.isFinite(request.ts) || Math.abs(now - request.ts) > CLOCK_SKEW) return
    for (const [id, at] of this.seen) {
      if (now - at <= 2 * CLOCK_SKEW) break
      this.seen.delete(id)
    }
    if (this.seen.has(request.id)) return
    this.seen.set(request.id, now)
    Promise.resolve()
      .then(() => this.handle(entry, request))
      .catch(() => ({ status: 500, body: { error: 'failed' } }))
      .then((answer) => this.send(client, entry.ch, { id: request.id, status: answer.status, body: answer.body }))
  }

  // announce tells every paired car on this broker that the bridge is (back)
  // there: what it sent before got no answer and should go again now, not
  // when its long poll runs out. Published after the subscriptions on the
  // same connection, so the retry finds them in place.
  announce(client) {
    for (const entry of this.channels.values()) if (entry.info.device) this.send(client, entry.ch, { type: 'restart' })
  }

  send(client, ch, value) {
    try {
      for (const part of chunks(seal(ch.kDown, ch.down, value))) if (!client.publish(ch.down, part)) return false
      return true
    } catch (error) {
      this.log(`relay answer: ${error.message}`)
      return false
    }
  }

  // broadcast reaches the car on whichever broker it listens.
  broadcast(ch, value) {
    let sent = false
    for (const client of this.clients) sent = this.send(client, ch, value) || sent
    return sent
  }
}

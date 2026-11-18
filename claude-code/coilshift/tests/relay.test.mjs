import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Bridge } from '../bin/coilshift-bridge.mjs'
import {
  ANSWER_LABEL,
  Assembler,
  MqttClient,
  OFFER_LABEL,
  Relay,
  boxKey,
  boxKeys,
  carCode,
  carCodeFor,
  channel,
  chunks,
  open,
  packet,
  rawPublic,
  readPacket,
  relayBrokers,
  seal,
} from '../lib/relay.mjs'

// Enough of an MQTT broker for the relay: exact topics, QoS 0.
function fakeBroker() {
  const subs = new Map()
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      for (let p = readPacket(buffer); p; p = readPacket(buffer)) {
        buffer = buffer.subarray(p.size)
        if (p.type === 1) socket.write(packet(0x20, Buffer.from([0, 0])))
        else if (p.type === 8 || p.type === 10) {
          for (let i = 2; i + 2 <= p.body.length; ) {
            const n = p.body.readUInt16BE(i)
            const topic = p.body.subarray(i + 2, i + 2 + n).toString()
            if (p.type === 8) {
              if (!subs.has(topic)) subs.set(topic, new Set())
              subs.get(topic).add(socket)
              i += 3 + n
            } else {
              subs.get(topic)?.delete(socket)
              i += 2 + n
            }
          }
          socket.write(packet(p.type === 8 ? 0x90 : 0xb0, p.type === 8 ? Buffer.concat([p.body.subarray(0, 2), Buffer.from([0])]) : p.body.subarray(0, 2)))
        } else if (p.type === 3) {
          const topic = p.body.subarray(2, 2 + p.body.readUInt16BE(0)).toString()
          for (const s of subs.get(topic) || []) s.write(packet(0x30, p.body))
        } else if (p.type === 12) socket.write(packet(0xd0))
      }
    })
    socket.on('close', () => {
      for (const set of subs.values()) set.delete(socket)
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, broker: `127.0.0.1:${server.address().port}` })))
}

const plain = (broker) => {
  const [host, port] = broker.split(':')
  return { socket: net.connect({ host, port: Number(port) }), ready: 'connect' }
}

function until(check, ms = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = check()
      if (value) return resolve(value)
      if (Date.now() - started > ms) return reject(new Error('timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

test('channels and sealed messages match the car (services/claude/relay_test.go)', () => {
  const d = channel('device', Buffer.alloc(32, 7))
  assert.equal(d.up, 'cs-claude/v1/09857b5d1d7786d27ad33b0ee166a6d4/up')
  assert.equal(d.kUp.toString('hex'), '62e56e0e4b675cf3b110cc0b3c75af75480dfbd2f33b8f281ef24d5b5ed3c4af')
  assert.equal(d.kDown.toString('hex'), 'bb7e17fe2331cb3d75a18748767b963d67fb28764ee58105253c27ce8ba745dd')
  assert.equal(channel('car', 'K7QM4ZP2XR9THB3D').down, 'cs-claude/v1/4a4ed226be026b28e3ee38f884c0e78e/down')
  assert.equal(channel('pair', 'a'.repeat(32)).up, 'cs-claude/v1/ede0661bd7cc0ac436b9a7ce03a998bf/up')
  const blob = seal(d.kDown, d.down, { ok: true })
  assert.deepEqual(open(d.kDown, d.down, blob), { ok: true })
  assert.throws(() => open(d.kDown, d.up, blob))
  assert.throws(() => open(d.kUp, d.down, blob))
  // The car's code commits to its key; boxes between X25519 keys.
  assert.equal(carCodeFor(Buffer.alloc(32, 9)), 'PFTW7VYVZK0SREXF')
  const pkcs8 = (d) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), d]), format: 'der', type: 'pkcs8' })
  const mine = pkcs8(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)))
  const peer = rawPublic(crypto.createPublicKey(pkcs8(Buffer.alloc(32, 2))))
  assert.equal(peer.toString('hex'), 'ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59')
  assert.equal(boxKey(mine, peer, OFFER_LABEL).toString('hex'), '0b13500e0e285aa1d4bc6717c05b45c08b86fb649f53367fd3cbfff6d4b063ef')
  assert.throws(() => boxKey(mine, Buffer.alloc(32), OFFER_LABEL), 'a low-order key is refused')
  assert.throws(() => boxKey(mine, Buffer.alloc(31, 1), OFFER_LABEL))
})

test('long messages travel in parts and are put back together', () => {
  const blob = crypto.randomBytes(100 * 1024)
  const parts = chunks(blob)
  assert.equal(parts.length, 4)
  assert.equal(parts[0][0], 1)
  assert.equal(parts[3].readUInt16BE(9), 3)
  assert.equal(parts[3].readUInt16BE(11), 4)
  const a = new Assembler()
  assert.equal(a.add('k', parts[3]), null)
  assert.equal(a.add('k', parts[3]), null)
  assert.equal(a.add('k', parts[0]), null)
  assert.equal(a.add('k', parts[2]), null)
  assert.deepEqual(a.add('k', parts[1]), blob)
  assert.deepEqual(a.add('k', chunks(Buffer.from('tiny'))[0]), Buffer.from('tiny'))
})

test('car codes and broker settings', () => {
  assert.equal(carCode('k7qm-4zp2-xr9t-hb3d'), 'K7QM4ZP2XR9THB3D')
  assert.equal(carCode(' K7QM 4ZP2 XR9T HB3D '), 'K7QM4ZP2XR9THB3D')
  assert.equal(carCode('O7QM-4ZP2-XR9T-HBIL'), '07QM4ZP2XR9THB11')
  assert.equal(carCode('K7QM-4ZP2-XR9T'), '')
  assert.equal(carCode('K7QM-4ZP2-XR9T-HB3U'), '')
  assert.deepEqual(relayBrokers({}), ['broker.emqx.io:8883', 'broker.hivemq.com:8883'])
  assert.deepEqual(relayBrokers({ COILSHIFT_RELAY: 'off' }), [])
  assert.deepEqual(relayBrokers({ COILSHIFT_RELAY: 'mqtt.example.com, b.example:1883, bad host' }), ['mqtt.example.com:8883', 'b.example:1883'])
})

test('the relay answers each fresh request once, on the broker it came from', async () => {
  const { server, broker } = await fakeBroker()
  const ch = channel('device', crypto.randomBytes(32))
  const seen = []
  const relay = new Relay({
    brokers: [broker],
    dial: plain,
    handle: (entry, request) => {
      seen.push(request.path)
      return { status: 200, body: { echo: request.path, device: entry.info.device } }
    },
  })
  relay.add('device:d1', ch, { device: 'd1' })
  const answers = []
  const car = new MqttClient(broker, { dial: plain, onMessage: (topic, payload) => answers.push(open(ch.kDown, topic, payload.subarray(13))) })
  car.subscribe(ch.down)
  car.start()
  try {
    await until(() => car.state === 'up' && relay.clients[0].state === 'up')
    const send = (request, key = ch.kUp) => {
      for (const part of chunks(seal(key, ch.up, request))) car.publish(ch.up, part)
    }
    const request = { id: crypto.randomBytes(16).toString('hex'), ts: Date.now(), method: 'GET', path: '/v1/ping' }
    send(request)
    await until(() => answers.length === 1)
    assert.deepEqual(answers[0], { id: request.id, status: 200, body: { echo: '/v1/ping', device: 'd1' } })
    send(request)
    send({ ...request, id: crypto.randomBytes(16).toString('hex'), ts: Date.now() - 11 * 60 * 1000 })
    send({ ...request, id: crypto.randomBytes(16).toString('hex') }, crypto.randomBytes(32))
    send({ ...request, id: crypto.randomBytes(16).toString('hex'), path: '/v1/state' })
    await until(() => answers.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(seen, ['/v1/ping', '/v1/state'], 'replayed, stale and foreign requests get no answer')
  } finally {
    car.stop()
    relay.stop()
    server.close()
  }
})

function bridge(brokers = ['broker.example:8883']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-'))
  fs.mkdirSync(path.join(dir, 'projects'))
  let now = 1_800_000_000_000
  const b = new Bridge(dir, { name: 'Testmac', projectsDir: path.join(dir, 'projects'), now: () => now, agents: async () => [] })
  const added = new Map()
  const sent = []
  b.attachRelay({ add: (name, ch, info) => added.set(name, { ch, info }), remove: (name) => added.delete(name), broadcast: (ch, value) => sent.push(value) }, brokers)
  b.advance = (ms) => (now += ms)
  b.added = added
  b.sent = sent
  return b
}

// What the car does with a sealed pairing answer.
function unseal(car, answer) {
  return open(boxKey(car.privateKey, Buffer.from(answer.mac, 'hex'), ANSWER_LABEL), ANSWER_LABEL, Buffer.from(answer.sealed, 'hex'))
}

test('relay routes: a code channel pairs only with its code, a car channel serves only its car', async () => {
  const b = bridge()
  const { link } = b.pairingLink('f'.repeat(64), ['192.168.1.2'])
  const params = new URLSearchParams(new URL(link).hash.slice(1))
  assert.equal(params.get('r'), 'broker.example:8883')
  const code = params.get('c')
  const entry = b.added.get('pair:' + code)
  assert.ok(entry, 'a new code listens on the relay')
  const req = (path, body = {}, auth) => ({ id: '0'.repeat(32), ts: 0, method: path === '/v1/ping' ? 'GET' : 'POST', path, body, auth })
  const carKey = boxKeys()
  const pub = rawPublic(carKey.publicKey).toString('hex')
  assert.equal((await b.relayRequest(entry, req('/v1/ping'))).status, 403)
  assert.equal((await b.relayRequest(entry, req('/v1/pair', { code: 'b'.repeat(32), device: 'x', pub }))).status, 403)
  assert.equal((await b.relayRequest(entry, req('/v1/pair', { code, device: 'x' }))).status, 400, 'through the relay the car key is required')
  assert.equal((await b.relayRequest(entry, req('/v1/pair', { code, device: 'x', pub: '0'.repeat(64) }))).status, 400, 'a low-order key does not spend the code')
  const paired = await b.relayRequest(entry, req('/v1/pair', { code, device: 'Tesla Model Y', pub }))
  assert.equal(paired.status, 200)
  assert.equal(paired.body.token, undefined, 'the token is not readable for a holder of the code')
  const secret = unseal(carKey, paired.body)
  assert.match(secret.token, /^[0-9a-f]{64}$/)
  assert.match(secret.relay.key, /^[0-9a-f]{64}$/)
  assert.deepEqual(secret.relay.brokers, ['broker.example:8883'])
  const again = await b.relayRequest(entry, req('/v1/pair', { code, device: 'Tesla Model Y', pub }))
  assert.equal(unseal(carKey, again.body).token, secret.token, 'a retry with the same key gets the same token')
  const thief = boxKeys()
  assert.equal((await b.relayRequest(entry, req('/v1/pair', { code, device: 'x', pub: rawPublic(thief.publicKey).toString('hex') }))).status, 403)
  assert.equal(b.config.devices.length, 1)
  b.advance(3 * 60 * 1000)
  assert.equal((await b.relayRequest(entry, req('/v1/pair', { code, device: 'x', pub }))).status, 403, 'the retry window closes')

  const device = b.config.devices[0]
  const car = b.added.get('device:' + device.id)
  assert.ok(car, 'the paired car listens on its own channel')
  const auth = 'Bearer ' + secret.token
  assert.equal((await b.relayRequest(car, req('/v1/ping', {}, auth))).status, 200)
  assert.equal((await b.relayRequest(car, req('/v1/relay', {}, auth))).body.key, device.relay)
  assert.equal((await b.relayRequest(car, req('/v1/pair', { code }, auth))).status, 403)
  assert.equal((await b.relayRequest(car, { id: '1', ts: 0, method: 'GET', path: 'https://evil/v1/ping', auth })).status, 400)
  const other = b.redeem(b.newCode(), 'Zweitwagen')
  assert.equal((await b.relayRequest(car, req('/v1/ping', {}, 'Bearer ' + other))).status, 401, 'another car token does not fit this channel')
  assert.equal((await b.relayRequest(car, req('/v1/unpair', {}, auth))).status, 200)
  assert.equal(b.added.has('device:' + device.id), false)
})

test('a car paired before the relay gets its key over HTTPS; without brokers it is refused', async () => {
  const b = bridge([])
  const token = b.redeem(b.pairingLink('f'.repeat(64), ['192.168.1.2']).link.match(/c=([0-9a-f]{32})/)[1], 'Tesla')
  const url = new URL('https://bridge/v1/relay')
  const off = await b.handle({ method: 'POST', url, authorization: 'Bearer ' + token, body: {} })
  assert.equal(off.status, 410)
  b.brokers = ['broker.example:8883']
  const on = await b.handle({ method: 'POST', url, authorization: 'Bearer ' + token, body: {} })
  assert.equal(on.status, 200)
  assert.equal(on.body.key, b.config.devices[0].relay)
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.dir, 'config.json'), 'utf8')).devices[0].relay, on.body.key)
})

test('the offer for a car code opens only with the key the code commits to', () => {
  const b = bridge()
  assert.throws(() => b.pairCar('K7QM-4ZP2', 'f'.repeat(64)), /16 Zeichen/)
  const car = boxKeys()
  const code = carCodeFor(rawPublic(car.publicKey))
  const answer = b.pairCar(code.toLowerCase().replace(/(.{4})(?!$)/g, '$1-'), 'f'.repeat(64))
  assert.deepEqual(b.sent, [{ type: 'hello' }])
  const listen = b.added.get('car:' + code).info.onMessage
  const stranger = boxKeys()
  listen({ type: 'key', pub: rawPublic(stranger.publicKey).toString('hex') })
  listen({ type: 'key', pub: 'zz' })
  assert.equal(b.sent.length, 1, 'a key that does not fit the code gets nothing')
  listen({ type: 'key', pub: rawPublic(car.publicKey).toString('hex') })
  const sealed = b.sent[1]
  assert.equal(sealed.type, 'pair')
  assert.throws(() => open(boxKey(stranger.privateKey, Buffer.from(sealed.mac, 'hex'), OFFER_LABEL), OFFER_LABEL, Buffer.from(sealed.box, 'hex')))
  const offer = open(boxKey(car.privateKey, Buffer.from(sealed.mac, 'hex'), OFFER_LABEL), OFFER_LABEL, Buffer.from(sealed.box, 'hex'))
  assert.equal(offer.code, answer.code)
  assert.equal(offer.fingerprint, 'f'.repeat(64))
  assert.deepEqual(offer.brokers, ['broker.example:8883'])
})

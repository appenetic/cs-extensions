#!/usr/bin/env node
// CoilShift bridge: mirrors this Mac's Claude Code sessions to a paired Tesla
// and carries the driver's answers back.
//
//   coilshift-bridge.mjs serve     the daemon (started by the plugin's hooks)
//   coilshift-bridge.mjs pair      a one-time pairing link for the car's QR page
//   coilshift-bridge.mjs pair CODE pairs the car that shows CODE, through the relay
//   coilshift-bridge.mjs status    what the bridge sees
//   coilshift-bridge.mjs away on|off|auto
//   coilshift-bridge.mjs unpair --all
//   coilshift-bridge.mjs stop
//
// The car reaches the daemon over HTTPS (self-signed, pinned by the pairing link)
// from the LAN or the tailnet, or through the encrypted MQTT relay (lib/relay.mjs)
// when neither connects them. Hooks, session relays and this CLI use Unix sockets
// in the plugin data directory (mode 0700).
import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { VERSION, dataDir, ensureBridge, local, relaySocketPath, running, socketPath } from '../lib/common.mjs'
import { ANSWER_LABEL, OFFER_LABEL, Relay, boxKey, boxKeys, carCode, carCodeFor, channel, rawPublic, relayBrokers, seal } from '../lib/relay.mjs'

const MAX_MESSAGES = 60
const MAX_TEXT = 4000
const MAX_SESSIONS = 24
const PAIR_TTL = 10 * 60 * 1000
const CAR_OFFER_TTL = 3 * 60 * 1000
// Hook events that move a session up the car's list: a turn, a question or the
// session's start or end. Single tool calls do not, so sessions at work keep
// their places.
const ACTIVITY = new Set(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'])
const DRIVING_GRACE = 5 * 60 * 1000

// An error the car shows as is: a status and a German message.
const fail = (status, message) => Object.assign(new Error(message), { status })
const squash = (s) => String(s || '').replace(/\s+/g, ' ').replace(/…$/, '').trim()

// ---------------------------------------------------------------- text helpers

export function clip(text, limit = MAX_TEXT) {
  let s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, '')
    .trim()
  if (s.length > limit) s = s.slice(0, limit - 1).trimEnd() + '…'
  return s
}

export function toolSummary(name, input) {
  const i = input && typeof input === 'object' ? input : {}
  const pick = i.command || i.file_path || i.notebook_path || i.path || i.pattern || i.url || i.query || i.description || i.prompt || ''
  return clip(`${name}${pick ? ': ' + String(pick).split('\n')[0] : ''}`, 300)
}

// The visible part of a user turn in a transcript: slash commands as "/name args",
// no system reminders or local command output.
export function userText(content) {
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => userText(b.text))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content !== 'string') return ''
  let s = content
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(s)
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)
    return clip(`${name[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`)
  }
  s = s.replace(/<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g, '')
  return clip(s)
}

// The car shows tool calls only as a bubble of dots: a run of them is one entry
// that counts them, without names or arguments, and leaves room in the history
// for the conversation.
export function countTool(messages, id, at) {
  const last = messages[messages.length - 1]
  if (last && last.role === 'tool') {
    last.count = (last.count || 1) + 1
    last.at = at
    return false
  }
  messages.push({ id, role: 'tool', text: '', count: 1, at })
  return true
}

// The question Claude ended its turn with, if the last paragraph asks one.
export function closingQuestion(text) {
  const paragraphs = String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const last = paragraphs[paragraphs.length - 1] || ''
  return /\?\s*(\*\*)?\s*$/.test(last) || /\?\s*$/m.test(last) ? clip(last, 600) : ''
}

// ---------------------------------------------------------------- transcripts

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

// Transcripts are Claude Code's internal format. They only backfill history the
// hooks did not see, so anything unexpected in them is skipped.
export function parseTranscript(file, maxBytes = 512 * 1024) {
  const result = { messages: [], title: '', cwd: '' }
  let fd
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    fd = fs.openSync(file, 'r')
    fs.readSync(fd, buffer, 0, buffer.length, start)
    let lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines = lines.slice(1)
    for (const line of lines) {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (!e || typeof e !== 'object') continue
      if (e.type === 'ai-title' && e.aiTitle) result.title = clip(e.aiTitle, 120)
      if (e.type === 'custom-title' && e.customTitle) result.title = clip(e.customTitle, 120)
      if (e.isSidechain || e.isMeta || !e.message) continue
      if (typeof e.cwd === 'string') result.cwd = e.cwd
      const at = Date.parse(e.timestamp) || Date.now()
      const id = typeof e.uuid === 'string' ? e.uuid : undefined
      if (e.type === 'user') {
        const text = userText(e.message.content)
        if (text) result.messages.push({ id, role: 'user', text, at })
      } else if (e.type === 'assistant' && Array.isArray(e.message.content)) {
        e.message.content.forEach((b, i) => {
          const bid = id ? `${id}.${i}` : undefined
          if (b.type === 'text' && b.text) result.messages.push({ id: bid, role: 'assistant', text: clip(b.text), at })
          else if (b.type === 'tool_use') countTool(result.messages, bid, at)
        })
      }
    }
  } catch {
    return result
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  result.messages = result.messages.slice(-MAX_MESSAGES)
  return result
}

// transcriptTail reads the end of a transcript: when the conversation last
// moved (a user or assistant entry; Claude Code also writes metadata, so the
// file's time says little) and when Remote Control last reported the session
// as ended or archived from another device (close code 4090).
export function transcriptTail(file, maxBytes = 128 * 1024) {
  const result = { talkAt: 0, archivedAt: 0 }
  let fd
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    fd = fs.openSync(file, 'r')
    fs.readSync(fd, buffer, 0, buffer.length, start)
    let lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines = lines.slice(1)
    for (const line of lines) {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      const at = (e && Date.parse(e.timestamp)) || 0
      if (!at) continue
      if ((e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain) result.talkAt = Math.max(result.talkAt, at)
      if (e.type === 'system' && /code 4090|archived/i.test(String(e.content || ''))) result.archivedAt = Math.max(result.archivedAt, at)
    }
  } catch {
    return result
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  return result
}

// ---------------------------------------------------------------- network helpers

function v4ToInt(ip) {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0
}
function inCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask)
}
function privateV4(ip) {
  return inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16)
}

// The car comes from the LAN or the tailnet; nothing else reaches the bridge.
export function allowedPeer(address) {
  let a = String(address || '')
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (net.isIPv4(a)) return a.startsWith('127.') || privateV4(a) || inCidr(a, '100.64.0.0', 10) || inCidr(a, '169.254.0.0', 16)
  if (net.isIPv6(a)) {
    const l = a.toLowerCase()
    return l === '::1' || /^f[cd]/.test(l) || l.startsWith('fe80')
  }
  return false
}

// Tailscale first, so the link also works away from home; then the LAN.
export function bridgeHosts(interfaces = os.networkInterfaces()) {
  const tailnet = []
  const lan = []
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (inCidr(a.address, '100.64.0.0', 10) && /^(utun|tailscale)/.test(name)) tailnet.push(a.address)
      else if (privateV4(a.address)) lan.push(a.address)
    }
  }
  return [...tailnet, ...lan].slice(0, 4)
}

function envHosts() {
  const list = String(process.env.COILSHIFT_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.:-]{1,253}$/.test(h))
  return list.length ? list.slice(0, 4) : null
}

function computerName() {
  try {
    return clip(execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }), 80)
  } catch {
    return clip(os.hostname().replace(/\.local$/, ''), 80)
  }
}

function claudeBinary() {
  const candidates = [
    process.env.COILSHIFT_CLAUDE_BIN,
    process.env.CLAUDE_CODE_EXECPATH,
    ...String(process.env.PATH || '')
      .split(':')
      .map((d) => d && path.join(d, 'claude')),
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ]
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isFile()) {
        fs.accessSync(c, fs.constants.X_OK)
        return c
      }
    } catch {}
  }
  return 'claude'
}

// ---------------------------------------------------------------- the bridge

export class Bridge {
  constructor(dir, options = {}) {
    this.dir = dir
    this.now = options.now || Date.now
    this.claude = options.claude || claudeBinary()
    this.agentsSource = options.agents || (() => this.runAgents())
    this.spawnClaude = options.spawnClaude || ((args, cwd) => this.runClaude(args, cwd))
    this.projectsDir = options.projectsDir || process.env.COILSHIFT_PROJECTS_DIR || path.join(claudeHome(), 'projects')
    this.registryDir = options.registryDir || process.env.COILSHIFT_SESSIONS_DIR || path.join(claudeHome(), 'sessions')
    this.name = options.name || computerName()
    this.config = this.loadConfig()
    this.sessions = new Map()
    this.relays = new Map()
    this.codes = new Map()
    this.rev = 1
    this.waiters = []
    this.lastPoll = 0
    this.lastDriving = 0
    this.seq = 0
    this.transcripts = new Map()
    this.redeemed = new Map()
    this.mqtt = null
    this.brokers = []
  }

  // -------------------------------------------------------------- relay

  // attachRelay listens for every paired car that has a relay key.
  attachRelay(mqtt, brokers) {
    this.mqtt = mqtt
    this.brokers = brokers
    for (const d of this.config.devices) if (d.relay) mqtt.add('device:' + d.id, channel('device', Buffer.from(d.relay, 'hex')), { device: d.id })
  }

  relayInfo(device) {
    if (!this.brokers.length) return undefined
    if (!device.relay) {
      device.relay = crypto.randomBytes(32).toString('hex')
      this.saveConfig()
    }
    if (this.mqtt) this.mqtt.add('device:' + device.id, channel('device', Buffer.from(device.relay, 'hex')), { device: device.id })
    return { key: device.relay, brokers: this.brokers }
  }

  forget(devices) {
    for (const d of devices) if (this.mqtt) this.mqtt.remove('device:' + d.id)
    this.config.devices = this.config.devices.filter((d) => !devices.includes(d))
    this.saveConfig()
  }

  // A request that came through the relay runs through the same routes as one
  // over HTTPS. A pairing channel only redeems its own code; a car's channel
  // only serves that car.
  async relayRequest(entry, r) {
    if (!['GET', 'POST'].includes(r.method) || typeof r.path !== 'string' || !r.path.startsWith('/v1/')) return { status: 400, body: { error: 'invalid' } }
    const url = new URL(r.path, 'https://bridge')
    const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {}
    return this.handle({ method: r.method, url, authorization: r.auth, body, via: entry.info })
  }

  // pairCar answers the code the car shows. The car listens on a channel derived
  // from the code and, asked with hello, names its key. The code commits to that
  // key, so the offer sealed to it opens only in that car, not for someone who
  // read the code off the screen. Hello and offer repeat until the car pairs.
  pairCar(input, fingerprint) {
    if (!this.mqtt) throw fail(409, 'Das Internet-Relay ist ausgeschaltet (COILSHIFT_RELAY=off). Bitte über den QR-Code koppeln.')
    const code = carCode(input)
    if (!code) throw fail(400, 'Das ist kein Code aus dem Auto. Er hat 16 Zeichen, etwa K7QM-4ZP2-XR9T-HB3D.')
    const one = this.newCode()
    const ch = channel('car', code)
    const started = this.now()
    const mac = boxKeys()
    let box = null
    const send = () => this.mqtt.broadcast(ch, box ? { type: 'pair', mac: rawPublic(mac.publicKey).toString('hex'), box: box.toString('hex') } : { type: 'hello' })
    const onMessage = (message) => {
      if (box || !message || message.type !== 'key' || typeof message.pub !== 'string' || !/^[0-9a-f]{64}$/.test(message.pub)) return
      const pub = Buffer.from(message.pub, 'hex')
      if (carCodeFor(pub) !== code) return
      const offer = { type: 'pair', code: one, fingerprint, name: this.name, port: this.config.port, hosts: envHosts() || bridgeHosts(), brokers: this.brokers }
      try {
        box = seal(boxKey(mac.privateKey, pub, OFFER_LABEL), OFFER_LABEL, offer)
      } catch {
        return
      }
      send()
    }
    this.mqtt.add('car:' + code, ch, { onMessage })
    send()
    const timer = setInterval(() => {
      if (this.codes.has(one) && this.now() - started <= CAR_OFFER_TTL) return send()
      clearInterval(timer)
      if (this.mqtt) this.mqtt.remove('car:' + code)
    }, 3000)
    timer.unref?.()
    log(`pairing offer for car code ${code.slice(0, 4)}…`)
    return { ok: true, code: one, expires: started + CAR_OFFER_TTL }
  }

  // -------------------------------------------------------------- config

  loadConfig() {
    let c = {}
    try {
      c = JSON.parse(fs.readFileSync(path.join(this.dir, 'config.json'), 'utf8'))
    } catch {}
    const port = Number(process.env.COILSHIFT_PORT || c.port)
    return {
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 47621,
      devices: Array.isArray(c.devices) ? c.devices.filter((d) => d && /^[0-9a-f]{64}$/.test(d.hash)) : [],
      away: ['on', 'off', 'auto'].includes(c.away) ? c.away : 'auto',
      permission_mode: ['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(c.permission_mode) ? c.permission_mode : 'default',
      wait_minutes: Number.isInteger(c.wait_minutes) && c.wait_minutes >= 1 && c.wait_minutes <= 120 ? c.wait_minutes : 20,
    }
  }

  saveConfig() {
    const file = path.join(this.dir, 'config.json')
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  away() {
    if (this.config.away === 'on') return true
    if (this.config.away === 'off') return false
    return this.now() - this.lastDriving < DRIVING_GRACE
  }

  // -------------------------------------------------------------- change tracking

  touch() {
    this.rev++
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.resolve()
    }
  }

  waitRev(since, ms) {
    if (this.rev > since || ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const w = { resolve }
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w)
        resolve()
      }, ms)
      this.waiters.push(w)
    })
  }

  // -------------------------------------------------------------- sessions

  session(id) {
    let s = this.sessions.get(id)
    if (!s) {
      s = { id, cwd: '', title: '', name: '', kind: 'ended', status: 'ended', updated: this.now(), messages: [], pending: null,
        socket: '', transcript: '', hooked: false, backfilled: false, mtime: 0 }
      this.sessions.set(id, s)
    }
    return s
  }

  addMessage(s, role, text, id) {
    text = clip(text)
    if (!text) return
    s.messages.push({ id: id || `m${++this.seq}`, role, text, at: this.now() })
    if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES)
  }
  addTool(s) {
    if (countTool(s.messages, `m${this.seq + 1}`, this.now())) this.seq++
    if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES)
  }

  // tail is transcriptTail for a session, read again only when the file changed.
  tail(s) {
    if (!s.transcript) s.transcript = this.findTranscript(s.id)
    let mtime = 0
    try {
      mtime = fs.statSync(s.transcript).mtimeMs
    } catch {
      return { talkAt: 0, archivedAt: 0 }
    }
    if (s.tailAt !== mtime) {
      s.tailInfo = transcriptTail(s.transcript)
      s.tailAt = mtime
    }
    return s.tailInfo
  }

  // Claude Code keeps a file per running session in ~/.claude/sessions with
  // its current inbox socket and when its status last changed. Internal like
  // transcripts: anything unexpected is skipped.
  readRegistry() {
    const out = new Map()
    let names = []
    try {
      names = fs.readdirSync(this.registryDir)
    } catch {
      return out
    }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.registryDir, name), 'utf8'))
        if (r && typeof r.sessionId === 'string') out.set(r.sessionId, r)
      } catch {}
    }
    return out
  }

  findTranscript(id) {
    if (this.transcripts.has(id)) return this.transcripts.get(id)
    try {
      for (const project of fs.readdirSync(this.projectsDir)) {
        const file = path.join(this.projectsDir, project, `${id}.jsonl`)
        if (fs.existsSync(file)) {
          this.transcripts.set(id, file)
          return file
        }
      }
    } catch {}
    return ''
  }

  // History the hooks did not see: once for a hooked session, on every change
  // of the file for one that runs without the plugin's hooks. Answers whether
  // it read the file, so the caller can publish a new revision.
  backfill(s) {
    if (!s.transcript) s.transcript = this.findTranscript(s.id)
    if (!s.transcript || (s.hooked && s.backfilled)) return false
    let stat
    try {
      stat = fs.statSync(s.transcript)
    } catch {
      return false
    }
    if (!s.hooked && s.backfilled && stat.mtimeMs === s.mtime) return false
    const t = parseTranscript(s.transcript)
    s.mtime = stat.mtimeMs
    s.backfilled = true
    if (!s.hooked || s.messages.length === 0) s.messages = t.messages.map((m) => ({ ...m, id: m.id || `m${++this.seq}` }))
    if (t.title && !s.title) s.title = t.title
    if (!s.cwd) s.cwd = t.cwd
    const last = t.messages.length ? t.messages[t.messages.length - 1].at : 0
    if (!s.hooked && last) s.updated = Math.max(s.updated, last)
    return true
  }

  // Sessions without hooks change only in their transcript; a change wakes the
  // car's long poll like a hook would.
  refreshTranscripts() {
    let changed = false
    for (const s of [...this.sessions.values()].sort((a, b) => b.updated - a.updated).slice(0, MAX_SESSIONS)) {
      if (!s.hooked && this.backfill(s)) changed = true
    }
    if (changed) this.touch()
  }

  delivery(s) {
    if (s.pending && s.pending.waiter) return 'hook'
    if (s.kind !== 'ended' && s.socket && this.relays.has(s.socket)) return 'inbox'
    if (s.kind === 'ended' && s.cwd) return 'resume'
    // A running session without the plugin's inbox relay (started before the
    // plugin) cannot take text, but a copy of it can, in the background.
    if (s.cwd) return 'fork'
    return ''
  }

  view(s) {
    const p = s.pending
    return {
      id: s.id,
      title: clip(s.title || s.name || path.basename(s.cwd || '') || 'Sitzung', 120),
      cwd: s.cwd,
      kind: s.kind,
      status: s.pending ? 'waiting' : s.status,
      updated: Math.floor(s.updated),
      delivery: this.delivery(s),
      pending: p
        ? { id: p.id, kind: p.kind, title: p.title, text: p.text, tool: p.tool || '', detail: p.detail || '', questions: p.questions || [], since: p.since }
        : undefined,
      messages: s.messages,
    }
  }

  projects() {
    const seen = new Set()
    const list = []
    for (const s of [...this.sessions.values()].sort((a, b) => b.updated - a.updated)) {
      if (!s.cwd || seen.has(s.cwd) || list.length >= 12) continue
      seen.add(s.cwd)
      list.push({ cwd: s.cwd, title: path.basename(s.cwd) || s.cwd })
    }
    return list
  }

  snapshot() {
    const list = [...this.sessions.values()].filter((s) => !s.archived).sort((a, b) => b.updated - a.updated).slice(0, MAX_SESSIONS)
    let read = false
    for (const s of list) read = this.backfill(s) || read
    // New history is a new revision, or the car would keep its old copy.
    if (read) this.touch()
    return {
      rev: this.rev,
      bridge: { name: this.name, version: VERSION, away: this.away() },
      sessions: list.filter((s) => s.kind !== 'ended' || s.messages.length > 0).map((s) => this.view(s)),
      projects: this.projects(),
    }
  }

  // -------------------------------------------------------------- discovery

  runAgents() {
    return new Promise((resolve) => {
      execFile(this.claude, ['agents', '--json', '--all'], { timeout: 20000, maxBuffer: 8 << 20, cwd: os.homedir() }, (error, stdout) => {
        if (error) return resolve(null)
        try {
          const list = JSON.parse(stdout)
          resolve(Array.isArray(list) ? list : null)
        } catch {
          resolve(null)
        }
      })
    })
  }

  static status(raw) {
    const s = String(raw || '').toLowerCase()
    if (['idle', 'ready'].includes(s)) return 'idle'
    if (['busy', 'running', 'working', 'thinking', 'active', 'streaming'].includes(s)) return 'working'
    if (['blocked', 'waiting', 'needs_input', 'input', 'paused'].includes(s)) return 'waiting'
    if (['done', 'completed', 'complete', 'stopped', 'exited', 'failed', 'error', 'killed', 'finished'].includes(s)) return 'ended'
    return ''
  }

  // Active sessions from `claude agents --json --all`; a session it no longer
  // lists has ended. A failed listing changes nothing.
  async discover() {
    const list = await this.agentsSource()
    if (!list) return
    let changed = false
    const live = new Set()
    const registry = this.readRegistry()
    for (const a of list) {
      if (!a || typeof a.sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(a.sessionId)) continue
      const fresh = !this.sessions.has(a.sessionId)
      const s = this.session(a.sessionId)
      const reg = registry.get(a.sessionId) || {}
      const tail = this.tail(s)
      // Last activity is the last status change or conversation entry. A
      // session the bridge learns about only now (after a restart, or from
      // before the plugin) was not active just because the bridge found it.
      const active = Math.max(Number(reg.statusUpdatedAt) || 0, tail.talkAt)
      if (fresh) s.updated = active || Number(a.startedAt) || this.now()
      const status = Bridge.status(a.status || a.state)
      const kind = status === 'ended' ? 'ended' : a.kind === 'background' ? 'background' : 'interactive'
      if (kind !== 'ended') live.add(s.id)
      // Archived on claude.ai or in the app: hidden until the next prompt.
      const next = { cwd: s.cwd || clip(a.cwd, 512), name: clip(a.name, 120), kind, status: status || s.status,
        archived: tail.archivedAt > Math.max(tail.talkAt, s.activeAt || 0) }
      if (typeof reg.messagingSocketPath === 'string' && reg.messagingSocketPath) next.socket = reg.messagingSocketPath
      if (kind === 'ended') next.status = 'ended'
      let updated = s.updated
      if (s.kind === 'ended' && kind !== 'ended') updated = Math.max(updated, Number(a.startedAt) || 0)
      if (!s.hooked) updated = Math.max(updated, active)
      if (updated !== s.updated) next.updated = updated
      for (const [k, v] of Object.entries(next)) {
        if (s[k] !== v) {
          s[k] = v
          changed = true
        }
      }
    }
    for (const s of this.sessions.values()) {
      if (s.kind !== 'ended' && !live.has(s.id)) {
        s.kind = 'ended'
        s.status = 'ended'
        this.release(s)
        changed = true
      }
    }
    if (changed) this.touch()
  }

  // Recently written transcripts become ended sessions the car can resume.
  scanTranscripts(maxAgeMs = 3 * 24 * 3600 * 1000) {
    const found = []
    try {
      for (const project of fs.readdirSync(this.projectsDir)) {
        const dir = path.join(this.projectsDir, project)
        let files
        try {
          files = fs.readdirSync(dir)
        } catch {
          continue
        }
        for (const name of files) {
          const m = /^([0-9a-f-]{36})\.jsonl$/.exec(name)
          if (!m) continue
          const file = path.join(dir, name)
          try {
            const mtime = fs.statSync(file).mtimeMs
            if (this.now() - mtime < maxAgeMs) found.push({ id: m[1], file, mtime })
            this.transcripts.set(m[1], file)
          } catch {}
        }
      }
    } catch {
      return
    }
    found.sort((a, b) => b.mtime - a.mtime)
    let changed = false
    for (const t of found.slice(0, 30)) {
      if (this.sessions.has(t.id)) continue
      const s = this.session(t.id)
      s.transcript = t.file
      const tail = this.tail(s)
      s.updated = tail.talkAt || Math.floor(t.mtime)
      s.archived = tail.archivedAt > tail.talkAt
      changed = true
    }
    if (changed) this.touch()
  }

  // -------------------------------------------------------------- hooks

  release(s, output = {}) {
    if (s.pending && s.pending.waiter) s.pending.waiter(output)
    s.pending = null
  }

  newPrompt(kind, fields) {
    return { id: `p${crypto.randomBytes(6).toString('hex')}`, kind, since: this.now(), title: '', text: '', ...fields }
  }

  // Holds the hook's answer until the car replies, the wait ends or the hook goes.
  hold(s, prompt, res) {
    return new Promise((resolve) => {
      let done = false
      const finish = (output) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (s.pending === prompt) s.pending = null
        prompt.waiter = null
        this.touch()
        resolve(output || {})
      }
      const timer = setTimeout(() => finish({}), this.config.wait_minutes * 60 * 1000)
      prompt.waiter = finish
      if (res) res.on('close', () => finish({}))
      this.touch()
    })
  }

  // Answers {hookSpecificOutput} or {} for "go on as without the plugin".
  async hook(input, res) {
    const id = input && input.session_id
    const event = input && input.hook_event_name
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(id) || typeof event !== 'string') return {}
    if (event === 'SessionStart' || event === 'SessionEnd') log(`${event} ${id.slice(0, 8)}`)
    const s = this.session(id)
    const env = input._env || {}
    s.hooked = true
    if (typeof env.socket === 'string' && env.socket) s.socket = env.socket
    if (typeof input.cwd === 'string' && !s.cwd) s.cwd = input.cwd
    if (typeof input.transcript_path === 'string' && input.transcript_path) s.transcript = input.transcript_path
    if (typeof input.session_title === 'string' && input.session_title) s.title = clip(input.session_title, 120)
    if (s.kind === 'ended' && event !== 'SessionEnd') s.kind = 'interactive'
    if (ACTIVITY.has(event) || (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion')) {
      s.updated = s.activeAt = this.now()
      s.archived = false
    }
    switch (event) {
      case 'SessionStart':
        s.status = 'idle'
        if (s.messages.length === 0) this.backfill(s)
        break
      case 'UserPromptSubmit':
        if (s.pending && s.pending.kind === 'input') s.pending = null
        this.addMessage(s, 'user', userText(input.prompt))
        s.status = 'working'
        break
      case 'PreToolUse': {
        s.status = 'working'
        if (input.tool_name !== 'AskUserQuestion') break
        const questions = (input.tool_input && Array.isArray(input.tool_input.questions) ? input.tool_input.questions : []).slice(0, 4)
        const prompt = this.newPrompt('question', {
          title: 'Claude fragt',
          text: questions.map((q) => q.question).join('\n'),
          questions: questions.map((q) => ({
            question: clip(q.question, 1000),
            header: clip(q.header, 40),
            multiSelect: Boolean(q.multiSelect),
            options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => ({ label: clip(o.label, 120), description: clip(o.description, 300) })),
          })),
          toolInput: input.tool_input,
          originals: questions.map((q) => String(q.question || '')),
        })
        this.release(s)
        s.pending = prompt
        if (this.away() || s.kind === 'background') return this.hold(s, prompt, res)
        break
      }
      case 'PermissionRequest': {
        const prompt = this.newPrompt('permission', {
          title: 'Freigabe',
          tool: clip(input.tool_name, 64),
          detail: clip(toolSummary(input.tool_name, input.tool_input).replace(/^[^:]*:\s*/, ''), 1000),
          text: `Claude möchte ${clip(input.tool_name, 64)} ausführen.`,
        })
        this.release(s)
        s.pending = prompt
        s.status = 'waiting'
        if (this.away() || s.kind === 'background') return this.hold(s, prompt, res)
        break
      }
      case 'PostToolUse':
        if (input.tool_name === 'AskUserQuestion' && s.pending && s.pending.kind === 'question' && !s.pending.waiter) s.pending = null
        if (s.pending && s.pending.kind === 'permission' && !s.pending.waiter) s.pending = null
        this.addTool(s)
        s.status = 'working'
        break
      case 'Notification':
        if (input.notification_type === 'idle_prompt' && !s.pending) s.status = 'waiting'
        break
      case 'Stop': {
        const text = clip(input.last_assistant_message)
        if (text) this.addMessage(s, 'assistant', text)
        s.status = 'idle'
        const question = closingQuestion(text)
        if (question && !s.pending) s.pending = this.newPrompt('input', { title: 'Claude wartet auf dich', text: question })
        break
      }
      case 'SessionEnd':
        this.release(s)
        s.kind = 'ended'
        s.status = 'ended'
        break
    }
    this.touch()
    return {}
  }

  // -------------------------------------------------------------- answers

  static questionOutput(prompt, answers) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...(prompt.toolInput || {}), answers },
      },
    }
  }

  async deliverInbox(s, text) {
    const relay = this.relays.get(s.socket)
    if (!relay) throw fail(422, 'Diese Sitzung läuft ohne CoilShift-Relay, vermutlich seit vor der Plugin-Installation. Bitte die Sitzung neu starten.')
    const id = `d${++this.seq}`
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        relay.results.delete(id)
        reject(fail(504, 'Die Sitzung hat die Nachricht nicht rechtzeitig angenommen.'))
      }, 8000)
      relay.results.set(id, (ok, error) => {
        clearTimeout(timer)
        ok ? resolve() : reject(fail(502, 'Die Sitzung hat die Nachricht abgelehnt: ' + clip(error || 'unbekannt', 120)))
      })
    })
    relay.socket.write(JSON.stringify({ type: 'deliver', id, text }) + '\n')
    return result
  }

  permissionArgs() {
    switch (this.config.permission_mode) {
      case 'acceptEdits':
        return ['--permission-mode', 'acceptEdits']
      case 'plan':
        return ['--permission-mode', 'plan']
      case 'bypassPermissions':
        return ['--dangerously-skip-permissions']
      default:
        return []
    }
  }

  runClaude(args, cwd) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(cwd)) return reject(fail(422, 'Der Projektordner existiert auf dem Mac nicht mehr: ' + clip(cwd, 200)))
      execFile(this.claude, args, { cwd, timeout: 60000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`
        const m = /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(out)
        if (m) return resolve(m[1])
        const reason = clip(out.split('\n').find((l) => l.trim()) || (error && error.message) || 'claude failed', 300)
        reject(fail(422, 'Claude Code auf dem Mac: ' + reason))
      })
    })
  }

  static fromCar(text, source) {
    return `${source === 'voice' ? '[Aus dem Auto, per Sprache diktiert]' : '[Aus dem Auto]'} ${text}`
  }

  // reply: {session, prompt?, text?, answers?, decision?, source}
  async reply(r) {
    const s = this.sessions.get(r.session)
    if (!s) throw fail(404, 'Diese Sitzung kennt der Mac nicht mehr.')
    const text = clip(r.text)
    const answers = r.answers && typeof r.answers === 'object' ? r.answers : {}
    if (r.prompt) {
      const p = s.pending
      if (!p || p.id !== r.prompt) throw fail(409, 'Die Frage ist bereits beantwortet oder abgelaufen.')
      if (p.waiter) {
        if (p.kind === 'question') {
          // Keys are the questions as the car shows them; the hook needs the originals.
          const out = {}
          for (const [key, value] of Object.entries(answers)) {
            const i = p.questions.findIndex((q) => squash(q.question) === squash(key) || squash(q.question).startsWith(squash(key)))
            if (i >= 0 && typeof value === 'string' && value.trim()) out[p.originals[i]] = clip(value, 1000)
          }
          if (Object.keys(out).length === 0 && text && p.originals[0]) out[p.originals[0]] = text
          if (Object.keys(out).length === 0) throw fail(400, 'Bitte eine Antwort wählen oder sprechen.')
          this.addMessage(s, 'car', Object.entries(out).map(([q, a]) => `${q} → ${a}`).join('\n'))
          p.waiter(Bridge.questionOutput(p, out))
        } else if (p.kind === 'permission') {
          const allow = r.decision === 'allow'
          const message = text || 'Im Auto abgelehnt.'
          this.addMessage(s, 'car', allow ? `Freigegeben: ${p.tool}` : `Abgelehnt: ${p.tool}${text ? ' · ' + text : ''}`)
          p.waiter({
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message },
            },
          })
        }
        return { ok: true, delivered: 'hook' }
      }
      if (p.kind !== 'input') throw fail(422, 'Die Frage ist im Terminal offen. Mit eingeschaltetem Unterwegs-Modus lassen sich künftige Fragen im Auto beantworten.')
    }
    if (!text) throw fail(400, 'Bitte einen Text eingeben oder diktieren.')
    const message = Bridge.fromCar(text, r.source)
    if (this.delivery(s) === 'inbox') {
      await this.deliverInbox(s, message)
      if (s.pending && s.pending.kind === 'input') s.pending = null
      this.addMessage(s, 'car', text)
      s.status = 'working'
      s.updated = this.now()
      this.touch()
      return { ok: true, delivered: 'inbox' }
    }
    if (!s.cwd) throw fail(422, 'Für diese Sitzung ist kein Projektordner bekannt.')
    if (s.kind !== 'ended') {
      // The session keeps running in its terminal; a copy with its history
      // takes the text and works on in the background.
      const id = await this.spawnClaude(['--bg', '--resume', s.id, '--fork-session', ...this.permissionArgs(), message], s.cwd)
      if (s.pending && s.pending.kind === 'input') s.pending = null
      this.addMessage(s, 'car', text)
      s.updated = this.now()
      this.touch()
      setTimeout(() => this.discover().catch(() => {}), 1500)
      return { ok: true, delivered: 'fork', id }
    }
    await this.spawnClaude(['--bg', '--resume', s.id, ...this.permissionArgs(), message], s.cwd)
    if (s.pending) s.pending = null
    this.addMessage(s, 'car', text)
    s.kind = 'background'
    s.status = 'working'
    s.updated = this.now()
    this.touch()
    return { ok: true, delivered: 'resume' }
  }

  async start(body) {
    const cwd = String(body.cwd || '')
    const text = clip(body.text)
    if (!this.projects().some((p) => p.cwd === cwd) || !text) throw fail(400, 'Projekt oder Auftrag ungültig.')
    const name = clip(`Auto · ${text.split('\n')[0]}`, 48)
    const id = await this.spawnClaude(['--bg', '-n', name, ...this.permissionArgs(), Bridge.fromCar(text, body.source)], cwd)
    // The new session shows up through its hooks and the next discovery.
    setTimeout(() => this.discover().catch(() => {}), 1500)
    return { ok: true, id }
  }

  // -------------------------------------------------------------- pairing

  newCode() {
    const code = crypto.randomBytes(16).toString('hex')
    this.codes.set(code, this.now() + PAIR_TTL)
    if (this.mqtt) {
      this.mqtt.add('pair:' + code, channel('pair', code), { code })
      setTimeout(() => this.mqtt && this.mqtt.remove('pair:' + code), PAIR_TTL).unref?.()
    }
    return code
  }

  // COILSHIFT_HOSTS (comma-separated) overrides the detected addresses, for a
  // MagicDNS name or a fixed address the car should use instead.
  pairingLink(fingerprint, hosts = envHosts() || bridgeHosts()) {
    if (hosts.length === 0) throw new Error('no LAN or Tailscale address')
    const code = this.newCode()
    const params = new URLSearchParams({ c: code, f: fingerprint })
    if (hosts.length > 1) params.set('h', hosts.slice(1).join(','))
    params.set('n', this.name)
    if (this.brokers.length) params.set('r', this.brokers.join(','))
    return { link: `https://${hosts[0]}:${this.config.port}/pair#${params.toString()}`, hosts, expires: this.now() + PAIR_TTL }
  }

  // A code works once. The car that redeemed it may ask again for two minutes
  // with the same key and gets the same token, in case the answer got lost on
  // the way (the relay drops what a broker cannot deliver). The answer is sealed
  // to that key, so a retry by anyone else gains nothing.
  redeem(code, device, pub = '') {
    const again = this.redeemed.get(code)
    if (again && pub && again.pub === pub && this.now() - again.at < 2 * 60 * 1000) return again.token
    const expires = this.codes.get(code)
    if (!expires || expires < this.now()) return null
    // The code's relay channel stays until the code would have expired, for a
    // retry with the nonce.
    this.codes.delete(code)
    const token = crypto.randomBytes(32).toString('hex')
    this.config.devices.push({
      id: crypto.randomBytes(4).toString('hex'),
      name: clip(device || 'Tesla', 60),
      hash: crypto.createHash('sha256').update(token).digest('hex'),
      created: this.now(),
      seen: this.now(),
    })
    this.saveConfig()
    for (const [c, r] of this.redeemed) if (this.now() - r.at > 2 * 60 * 1000) this.redeemed.delete(c)
    if (pub) this.redeemed.set(code, { token, pub, at: this.now() })
    return token
  }

  device(authorization) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(String(authorization || ''))
    if (!m) return null
    const hash = crypto.createHash('sha256').update(m[1]).digest()
    return this.config.devices.find((d) => crypto.timingSafeEqual(Buffer.from(d.hash, 'hex'), hash)) || null
  }

  // -------------------------------------------------------------- the car's API

  async car(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!allowedPeer(req.socket.remoteAddress)) return reply(403, { error: 'forbidden' })
    const url = new URL(req.url, 'https://bridge')
    let body = {}
    if (req.method === 'POST') {
      try {
        body = await readJSON(req)
      } catch {
        return reply(400, { error: 'invalid' })
      }
    }
    const answer = await this.handle({ method: req.method, url, authorization: req.headers.authorization, body })
    reply(answer.status, answer.body)
  }

  // handle is the car's API, over HTTPS or the relay (via names the channel).
  async handle({ method, url, authorization, body, via }) {
    const reply = (status, value) => ({ status, body: value })
    if (via && via.code !== undefined && (method !== 'POST' || url.pathname !== '/v1/pair' || body.code !== via.code)) return reply(403, { error: 'forbidden' })
    if (method === 'POST' && url.pathname === '/v1/pair') {
      if (via && via.device) return reply(403, { error: 'forbidden' })
      // The car's X25519 key: token and relay key go back sealed to it. Through
      // the relay it is required, or a holder of the code could read them. It is
      // checked before the code is spent.
      let key = null
      if (typeof body.pub === 'string' && /^[0-9a-f]{64}$/.test(body.pub)) {
        const mac = boxKeys()
        try {
          key = { mac: rawPublic(mac.publicKey).toString('hex'), box: boxKey(mac.privateKey, Buffer.from(body.pub, 'hex'), ANSWER_LABEL) }
        } catch {
          return reply(400, { error: 'invalid' })
        }
      }
      if (via && !key) return reply(400, { error: 'invalid' })
      const token = typeof body.code === 'string' && /^[0-9a-f]{32}$/.test(body.code) ? this.redeem(body.code, body.device, key ? body.pub : '') : null
      if (!token) return reply(403, { error: 'code' })
      log(`paired ${clip(body.device, 60)}${via ? ' through the relay' : ''}`)
      this.touch()
      const secret = { token, relay: this.relayInfo(this.device('Bearer ' + token)) }
      if (!key) return reply(200, { ...secret, name: this.name, version: VERSION })
      return reply(200, { name: this.name, version: VERSION, mac: key.mac, sealed: seal(key.box, ANSWER_LABEL, secret).toString('hex') })
    }
    const device = this.device(authorization)
    if (!device || (via && via.device !== device.id)) return reply(401, { error: 'token' })
    try {
      if (method === 'GET' && url.pathname === '/v1/ping') return reply(200, { ok: true, version: VERSION })
      if (method === 'POST' && url.pathname === '/v1/relay') {
        // A car paired before the relay existed asks for its key over HTTPS.
        const info = this.relayInfo(device)
        return info ? reply(200, info) : reply(410, { error: 'relay_off', message: 'Das Internet-Relay ist auf dem Mac ausgeschaltet.' })
      }
      if (method === 'GET' && url.pathname === '/v1/state') {
        const since = Number(url.searchParams.get('since'))
        const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait')) || 0))
        const gear = url.searchParams.get('gear') || ''
        this.lastPoll = this.now()
        const wasAway = this.away()
        if (['D', 'R', 'N'].includes(gear)) this.lastDriving = this.now()
        if (this.away() !== wasAway) this.touch()
        if (this.now() - (device.seen || 0) > 60000) {
          device.seen = this.now()
          this.saveConfig()
        }
        await this.waitRev(Number.isFinite(since) ? since : 0, wait * 1000)
        return reply(200, this.snapshot())
      }
      if (method === 'POST' && url.pathname === '/v1/reply') return reply(200, await this.reply(body))
      if (method === 'POST' && url.pathname === '/v1/start') return reply(200, await this.start(body))
      if (method === 'POST' && url.pathname === '/v1/away') {
        this.config.away = body.on ? 'on' : 'auto'
        this.saveConfig()
        this.touch()
        return reply(200, { ok: true, away: this.away() })
      }
      if (method === 'POST' && url.pathname === '/v1/diag') {
        // The car's own diagnostics (web port, card, voice), for /coilshift:status.
        const values = {}
        for (const [key, value] of Object.entries(body.values && typeof body.values === 'object' ? body.values : {}).slice(0, 24)) {
          if (/^[A-Za-z0-9._-]{1,40}$/.test(key)) values[key] = clip(value, 300)
        }
        const changed = JSON.stringify((device.diag || {}).values) !== JSON.stringify(values)
        device.diag = { at: this.now(), version: clip(body.version, 40), firmware: clip(body.firmware, 60), values }
        if (changed) {
          const shown = Object.entries(values).filter(([key]) => key !== 'voice.last')
          log(`car ${device.name} ${device.diag.version}: ${shown.map(([k, v]) => `${k}=${v}`).join(' | ')}`)
        }
        return reply(200, { ok: true })
      }
      if (method === 'POST' && url.pathname === '/v1/unpair') {
        this.forget([device])
        return reply(200, { ok: true })
      }
    } catch (error) {
      return reply(error.status || 500, { error: 'failed', message: error.status ? clip(error.message, 300) : 'Interner Fehler der Bridge.' })
    }
    return reply(404, { error: 'not_found' })
  }

  // -------------------------------------------------------------- relays

  relay(socket) {
    let entry = null
    readline.createInterface({ input: socket }).on('line', (line) => {
      let m
      try {
        m = JSON.parse(line)
      } catch {
        return
      }
      if (m.type === 'hello' && typeof m.socket === 'string' && m.socket) {
        entry = { socket, results: new Map(), inbox: m.socket }
        this.relays.set(m.socket, entry)
        log(`relay for ${path.basename(m.socket)}`)
        this.touch()
      } else if (m.type === 'result' && entry && entry.results.has(m.id)) {
        const done = entry.results.get(m.id)
        entry.results.delete(m.id)
        done(Boolean(m.ok), m.error)
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (entry && this.relays.get(entry.inbox) === entry) {
        this.relays.delete(entry.inbox)
        this.touch()
      }
    })
  }
}

function readJSON(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value = text ? JSON.parse(text) : {}
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
        resolve(value)
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- daemon

let logFile = ''
function log(message) {
  if (!logFile) return
  try {
    if (fs.statSync(logFile).size > 1 << 20) fs.renameSync(logFile, logFile + '.1')
  } catch {}
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
  } catch {}
}

function ensureCertificate(dir) {
  const cert = path.join(dir, 'cert.pem')
  const key = path.join(dir, 'key.pem')
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    // A named curve: LibreSSL's one-step `req -newkey ec` writes explicit
    // parameters, which Go's x509 parser on the car refuses.
    const options = { stdio: 'ignore', env: { ...process.env, PATH: `/usr/bin:${process.env.PATH || ''}` } }
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-param_enc', 'named_curve', '-genkey', '-noout', '-out', key], options)
    fs.chmodSync(key, 0o600)
    execFileSync('openssl', ['req', '-new', '-x509', '-key', key, '-days', '3650', '-subj', '/CN=coilshift-claude-bridge', '-out', cert], options)
  }
  const pem = fs.readFileSync(cert)
  return { cert: pem, key: fs.readFileSync(key), fingerprint: new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase() }
}

// One daemon per data directory: an exclusive lock file names its process.
function lock(dir) {
  const file = path.join(dir, 'bridge.lock')
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 })
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file)
        } catch {}
      }
    } catch {
      try {
        process.kill(Number(fs.readFileSync(file, 'utf8')), 0)
        return null
      } catch {
        fs.rmSync(file, { force: true })
      }
    }
  }
  return null
}

function listenUnix(server, file) {
  fs.rmSync(file, { force: true })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(file, () => {
      fs.chmodSync(file, 0o600)
      resolve()
    })
  })
}

async function serve(dir) {
  const unlock = lock(dir)
  if (!unlock) return
  logFile = path.join(dir, 'bridge.log')
  const bridge = new Bridge(dir)
  const tls = ensureCertificate(dir)
  const brokers = relayBrokers()
  if (brokers.length) bridge.attachRelay(new Relay({ brokers, log, handle: (entry, request) => bridge.relayRequest(entry, request) }), brokers)
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const localServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local')
    try {
      if (req.method === 'GET' && url.pathname === '/ping') return send(res, 200, { ok: true, version: VERSION, pid: process.pid })
      if (req.method === 'POST' && url.pathname === '/hook') return send(res, 200, await bridge.hook(await readJSON(req, 1 << 20), res))
      if (req.method === 'POST' && url.pathname === '/pair/new') return send(res, 200, bridge.pairingLink(tls.fingerprint))
      if (req.method === 'POST' && url.pathname === '/pair/car') return send(res, 200, bridge.pairCar((await readJSON(req)).code, tls.fingerprint))
      if (req.method === 'GET' && url.pathname === '/status') {
        const snap = bridge.snapshot()
        return send(res, 200, {
          name: bridge.name, version: VERSION, port: bridge.config.port, hosts: envHosts() || bridgeHosts(), fingerprint: tls.fingerprint,
          away: bridge.config.away, awayNow: bridge.away(),
          devices: bridge.config.devices.map(({ id, name, created, seen, diag, relay }) => ({ id, name, created, seen, diag, relay: Boolean(relay) })),
          lastPoll: bridge.lastPoll, relays: bridge.relays.size, mqtt: bridge.mqtt ? bridge.mqtt.status() : [],
          sessions: snap.sessions.map((s) => ({ title: s.title, kind: s.kind, status: s.status, delivery: s.delivery })),
        })
      }
      if (req.method === 'POST' && url.pathname === '/away') {
        const body = await readJSON(req)
        if (!['on', 'off', 'auto'].includes(body.mode)) return send(res, 400, { error: 'mode' })
        bridge.config.away = body.mode
        bridge.saveConfig()
        bridge.touch()
        return send(res, 200, { ok: true, away: bridge.config.away })
      }
      if (req.method === 'POST' && url.pathname === '/unpair') {
        bridge.forget([...bridge.config.devices])
        return send(res, 200, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/stop') {
        send(res, 200, { ok: true })
        setTimeout(() => process.exit(0), 100)
        return
      }
      send(res, 404, { error: 'not_found' })
    } catch (error) {
      send(res, 400, { error: 'invalid', message: clip(error.message, 200) })
    }
  })
  localServer.requestTimeout = 0
  localServer.headersTimeout = 10000
  await listenUnix(localServer, socketPath(dir))
  await listenUnix(
    net.createServer((socket) => bridge.relay(socket)),
    relaySocketPath(dir),
  )
  const carServer = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, (req, res) => {
    bridge.car(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'failed' })
    })
  })
  carServer.headersTimeout = 10000
  carServer.requestTimeout = 60000
  carServer.on('error', (error) => {
    log(`car port ${bridge.config.port}: ${error.code || error.message}`)
    process.exit(1)
  })
  carServer.listen(bridge.config.port, '0.0.0.0')
  log(`bridge ${VERSION} on port ${bridge.config.port}, pid ${process.pid}`)
  const cleanup = () => {
    if (bridge.mqtt) bridge.mqtt.stop()
    unlock()
    fs.rmSync(socketPath(dir), { force: true })
    fs.rmSync(relaySocketPath(dir), { force: true })
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  // Discovery is frequent while a car is polling and slow otherwise.
  const loop = async () => {
    try {
      await bridge.discover()
      bridge.scanTranscripts()
      bridge.refreshTranscripts()
    } catch (error) {
      log(`discovery: ${error.message}`)
    }
    const active = Date.now() - bridge.lastPoll < 3 * 60 * 1000
    setTimeout(loop, active ? 8000 : 60000)
  }
  loop()
}

// ---------------------------------------------------------------- CLI

const RELAY_STATE = { up: 'verbunden', connecting: 'verbindet', down: 'getrennt', idle: 'wartet' }

// pairCar sends the pairing to the car that shows code and waits until it has
// paired (the car keeps its pairing window open for ten minutes).
async function pairCar(dir, code) {
  const before = new Set(((await local(dir, 'GET', '/status')).body.devices || []).map((d) => d.id))
  const answer = await local(dir, 'POST', '/pair/car', { code })
  if (answer.status !== 200) return console.log('Keine Kopplung: ' + ((answer.body && answer.body.message) || 'unbekannter Fehler'))
  console.log('Die Kopplung geht über das Internet-Relay ans Auto, Ende-zu-Ende-verschlüsselt. Warte auf das Auto …')
  const deadline = Date.now() + 90 * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const { body } = await local(dir, 'GET', '/status')
    const added = (body.devices || []).find((d) => !before.has(d.id))
    if (added) return console.log(`Gekoppelt mit ${added.name}. Die Claude-App im Auto zeigt jetzt deine Sitzungen.`)
  }
  console.log(
    [
      'Das Auto hat sich noch nicht gemeldet. Das Angebot gilt noch drei Minuten.',
      'Bitte prüfen: Ist die Claude-App im Auto mit dem Kopplungscode offen, stimmt der Code, und hat das Auto Internet?',
      'Danach mit /coilshift:status nachsehen, ob das Auto gekoppelt ist.',
    ].join('\n'),
  )
}

async function cli() {
  const [command, ...args] = process.argv.slice(2).filter((a, i, all) => a !== '--data' && all[i - 1] !== '--data')
  const dir = dataDir()
  switch (command) {
    case 'serve':
      return serve(dir)
    case 'pair': {
      if (!(await ensureBridge(dir))) return console.log('Die Bridge startet nicht. Details: ' + path.join(dir, 'bridge.log'))
      if (args.join('').trim()) return pairCar(dir, args.join(''))
      const answer = await local(dir, 'POST', '/pair/new', {})
      if (answer.status !== 200) return console.log('Kein Kopplungslink: ' + ((answer.body && answer.body.message) || 'unbekannter Fehler'))
      let copied = false
      try {
        execFileSync('/usr/bin/pbcopy', { input: answer.body.link })
        copied = true
      } catch {}
      console.log(
        [
          'Kopplungslink (gültig 10 Minuten, nur einmal verwendbar):',
          '',
          answer.body.link,
          '',
          copied ? 'Der Link ist in der Zwischenablage, per Universal Clipboard auch auf dem iPhone.' : '',
          'So geht es weiter:',
          '1. Im Auto die Claude-App öffnen und den QR-Code mit dem Handy scannen.',
          '2. Auf der Handy-Seite den Link einfügen und »Koppeln« tippen.',
          `Das Auto versucht zuerst ${answer.body.hosts.join(', ')} (Tailscale vor WLAN)${answer.body.link.includes('&r=') ? ', sonst das Internet-Relay' : ''}.`,
          'Ohne gemeinsames WLAN: den Code aus der Claude-App im Auto hier angeben, also /coilshift:pair <Code>.',
        ]
          .filter((l) => l !== null)
          .join('\n'),
      )
      return
    }
    case 'status': {
      if (!(await running(dir))) return console.log('Die Bridge läuft nicht. Sie startet mit der nächsten Claude-Code-Sitzung.')
      const { body } = await local(dir, 'GET', '/status')
      const lines = [
        `CoilShift-Bridge ${body.version} auf ${body.name}, Port ${body.port}`,
        `Adressen: ${body.hosts.join(', ') || 'keine LAN-/Tailscale-Adresse'}`,
        `Internet-Relay: ${(body.mqtt || []).length ? body.mqtt.map((b) => `${b.broker} ${RELAY_STATE[b.state] || b.state}${b.error && b.state !== 'up' ? ' (' + b.error + ')' : ''}`).join(', ') : 'aus'}`,
        `Unterwegs-Modus: ${body.away}${body.awayNow ? ' (gerade aktiv)' : ''}`,
        `Gekoppelte Autos: ${body.devices.length ? body.devices.map((d) => `${d.name} (zuletzt ${new Date(d.seen).toLocaleString('de-DE')}${d.relay ? ', mit Internet-Relay' : ''})`).join(', ') : 'keine'}`,
        `Letzte Abfrage des Autos: ${body.lastPoll ? new Date(body.lastPoll).toLocaleString('de-DE') : 'noch keine'}`,
        `Sitzungen mit Relay: ${body.relays}`,
        ...body.devices
          .filter((d) => d.diag)
          .flatMap((d) => [
            `Diagnose von ${d.name} (${d.diag.version || '?'}, ${new Date(d.diag.at).toLocaleTimeString('de-DE')}):`,
            ...Object.entries(d.diag.values).map(([k, v]) => `  ${k}: ${v}`),
          ]),
        ...body.sessions.slice(0, 10).map((s) => `  · ${s.title} — ${s.kind}, ${s.status}${s.delivery ? ', Antwort per ' + s.delivery : ''}`),
      ]
      return console.log(lines.join('\n'))
    }
    case 'away': {
      const mode = args[0]
      if (!['on', 'off', 'auto'].includes(mode)) return console.log('Aufruf: away on|off|auto')
      if (!(await ensureBridge(dir))) return console.log('Die Bridge startet nicht.')
      await local(dir, 'POST', '/away', { mode })
      return console.log(`Unterwegs-Modus: ${mode}`)
    }
    case 'unpair':
      if (!(await running(dir))) return console.log('Die Bridge läuft nicht.')
      await local(dir, 'POST', '/unpair', {})
      return console.log('Alle Autos entkoppelt.')
    case 'stop':
      if (!(await running(dir))) return console.log('Die Bridge läuft nicht.')
      await local(dir, 'POST', '/stop', {}).catch(() => {})
      return console.log('Bridge gestoppt.')
    default:
      console.log('Aufruf: coilshift-bridge.mjs serve|pair [Code]|status|away on|off|auto|unpair|stop [--data DIR]')
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) cli()

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
import { VERSION, dataDir, ensureBridge, local, macLang, relaySocketPath, running, socketPath } from '../lib/common.mjs'
import { ANSWER_LABEL, OFFER_LABEL, Relay, boxKey, boxKeys, carCode, carCodeFor, channel, rawPublic, relayBrokers, seal } from '../lib/relay.mjs'

const MAX_MESSAGES = 60
const MAX_TEXT = 4000
// What the car shows of a sub-agent's report, read on a tap.
const MAX_RESULT = 2000
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const MAX_SESSIONS = 24
// Pasted images: at most this many per message, made at most this many pixels
// a side for the car, and as base64 at most this large before. Images and
// speech for the car are at most MAX_MEDIA as base64.
const MAX_IMAGES = 4
const IMAGE_EDGE = 1024
const MAX_IMAGE_SOURCE = 32 << 20
const MAX_MEDIA = 2 << 20
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const PAIR_TTL = 10 * 60 * 1000
const CAR_OFFER_TTL = 3 * 60 * 1000
// Hook events that move a session up the car's list: a turn, a question or the
// session's start or end. Single tool calls do not, so sessions at work keep
// their places.
const ACTIVITY = new Set(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'])
const DRIVING_GRACE = 5 * 60 * 1000
// A slash command alone, as "/usage" or "/coilshift:pair", is no word to Claude.
const SLASH = /^\/[\w:-]+(\s|$)/
// How long a new session without a word stays out of the car's list.
const QUIET_START = 60 * 1000

// An error the car shows as is: a status and a message in the car's language.
const fail = (status, message) => Object.assign(new Error(message), { status })
const squash = (s) => String(s || '').replace(/\s+/g, ' ').replace(/…$/, '').trim()
// What the commands print on the Mac is in the Mac's language.
const toMac = (de, en) => (macLang() === 'en' ? en : de)

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

// A prompt from the car carries a mark in front (Bridge.fromCar); the car
// shows it as its own message, without the mark. Through a running session's
// inbox it comes as a message from another session: Claude Code puts this in
// front and writes it to the transcript as a meta entry.
const CAR_MARK = /^\[(?:Aus dem Auto(?:, per Sprache diktiert)?|From the car(?:, dictated by voice)?)\]\s*/
const INBOX = /^Another Claude session sent a message:\s*/

// taskNotifications reads what Claude Code tells a session, as a turn of its
// own, about its background work: a command or sub-agent that ended, a
// monitor's event and the like.
export function taskNotifications(text) {
  const out = []
  for (const m of String(text || '').matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const field = (name) => {
      const f = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(m[1])
      return f ? f[1].trim() : ''
    }
    out.push({ toolUseId: field('tool-use-id'), status: field('status'), summary: field('summary'), result: field('result') })
  }
  return out
}

// noteEntry is what a notification means for the car: the end of a sub-agent
// completes that agent's entry; the end of a background command, and anything
// else, is an event of its own.
export function noteEntry(n) {
  const agent = /^Agent "([\s\S]*?)" (finished|failed|is waiting|was stopped|stopped|killed)(?::\s*([\s\S]*))?/.exec(n.summary)
  if (agent) {
    if (agent[2] === 'is waiting') return { agent: { tool: n.toolUseId, name: clip(agent[1], 120), state: 'running' } }
    const state = /stopped|killed/.test(agent[2]) || n.status === 'killed' ? 'stopped' : agent[2] === 'finished' && n.status !== 'failed' ? 'done' : 'failed'
    return { agent: { tool: n.toolUseId, name: clip(agent[1], 120), state, result: clip(n.result || agent[3] || '', MAX_RESULT) } }
  }
  const command = /^Background command "([\s\S]*?)"/.exec(n.summary)
  if (command) {
    const code = /exit code (-?\d+)/.exec(n.summary)
    const exit = code ? Number(code[1]) : undefined
    const state = /was stopped|stopped|killed/.test(n.summary) || n.status === 'killed' ? 'stopped' : n.status === 'completed' && !exit ? 'done' : 'failed'
    return { event: { kind: 'command', state, text: clip(command[1], 300), ...(exit === undefined ? {} : { exit }) } }
  }
  return { event: { kind: 'notice', state: n.status === 'failed' ? 'failed' : '', text: clip(n.summary.split('\n')[0], 300) } }
}

// userTurn says what a user turn is for the car: the user's words, a prompt
// sent from the car, or notifications of background work.
export function userTurn(content) {
  const raw = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
  const notes = taskNotifications(raw)
  if (notes.length) return { notes }
  const text = userText(content).replace(INBOX, '')
  const car = CAR_MARK.exec(text)
  return car ? { role: 'car', text: clip(text.slice(car[0].length)) } : { role: 'user', text }
}

// markSteps marks Claude's words that more work followed in the same turn:
// the car shows them small, and a turn's last words as its answer. A prompt,
// a message from the car or an event begins a new turn, and so does a
// sub-agent's report back, though it shows on the agent's card.
export function markSteps(messages) {
  const ends = messages.filter((m) => m.role === 'agent' && m.ended).map((m) => m.ended)
  let more = false
  let after = Infinity
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (ends.some((t) => t > m.at && t <= after)) more = false
    after = m.at
    if (m.role === 'assistant') {
      if (more) m.step = true
      else delete m.step
      more = true
    } else if (m.role === 'tool' || m.role === 'agent') {
      more = true
    } else {
      more = false
    }
  }
  return messages
}

// toolResultText is the text of a tool's answer in a transcript.
function toolResultText(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
}

// Claude Code writes each pasted image into the prompt as "[Image #n]"; the
// image itself is only in the transcript.
export function imageCount(text) {
  return Math.min(MAX_IMAGES, (String(text || '').match(/\[Image #\d+\]/g) || []).length)
}

// talked says whether a history holds a conversation: anything from Claude, a
// tool or the car, or a prompt that is more than a slash command.
export function talked(messages) {
  return messages.some((m) => m.role !== 'user' || !SLASH.test(m.text))
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

// Transcripts are Claude Code's internal format; anything unexpected in them is
// skipped. The history comes from them: the prompts, every text of Claude's,
// runs of tool calls, sub-agents with their reports, background work that
// ended, and where the conversation was summarized. last is the time of the
// newest entry read.
export function parseTranscript(file, maxBytes = 512 * 1024) {
  const result = { messages: [], title: '', cwd: '', last: 0 }
  // Sub-agents by the id of the call that started them.
  const agents = new Map()
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
      if (e.isSidechain || !e.message) continue
      // Meta entries are Claude Code's own, but for a prompt through the inbox.
      if (e.isMeta && !(e.type === 'user' && INBOX.test(userText(e.message.content)))) continue
      if (typeof e.cwd === 'string') result.cwd = e.cwd
      const stamped = Date.parse(e.timestamp)
      if (stamped) result.last = Math.max(result.last, stamped)
      const at = stamped || Date.now()
      const id = typeof e.uuid === 'string' ? e.uuid : undefined
      if (e.type === 'user') {
        if (e.isCompactSummary) {
          result.messages.push({ id, role: 'event', kind: 'compact', state: '', text: '', at })
          continue
        }
        const content = e.message.content
        // The answer to a sub-agent's call: a report, or only that it started
        // in the background, whose notification ends it later.
        if (Array.isArray(content)) {
          for (const b of content) {
            const a = b && b.type === 'tool_result' && agents.get(b.tool_use_id)
            const r = e.toolUseResult
            if (!a || (r && typeof r === 'object' && (r.isAsync === true || /^async/i.test(String(r.status || ''))))) continue
            const text = toolResultText(b.content)
            if (/^Async agent launched/i.test(text)) continue
            Object.assign(a, { state: b.is_error ? 'failed' : 'done', ended: at, result: clip(text, MAX_RESULT) })
          }
        }
        const turn = userTurn(content)
        if (turn.notes) {
          turn.notes.forEach((n, k) => {
            const entry = noteEntry(n)
            if (entry.event) return result.messages.push({ id: id && `${id}.n${k}`, role: 'event', ...entry.event, at })
            const a = agents.get(entry.agent.tool)
            const ended = entry.agent.state === 'running' ? {} : { ended: at }
            const result_ = entry.agent.result ? { result: entry.agent.result } : {}
            // Started before the part read: the notification alone stands for it.
            if (!a) return result.messages.push({ id: id && `${id}.n${k}`, role: 'agent', text: entry.agent.name, agent: '', state: entry.agent.state, at, ...ended, ...result_ })
            Object.assign(a, { state: entry.agent.state, ...ended, ...result_ })
          })
          continue
        }
        // Images of tool results sit inside those; only pasted ones are top level.
        const images = turn.role === 'user' && Array.isArray(content) ? Math.min(MAX_IMAGES, content.filter((b) => b && b.type === 'image').length) : 0
        if (turn.text || images) result.messages.push({ id, role: turn.role, text: turn.text, at, ...(images ? { images } : {}) })
      } else if (e.type === 'assistant' && Array.isArray(e.message.content)) {
        e.message.content.forEach((b, i) => {
          const bid = id ? `${id}.${i}` : undefined
          if (b.type === 'text' && b.text) {
            result.messages.push({ id: bid, role: 'assistant', text: clip(b.text), at })
          } else if (b.type === 'tool_use' && AGENT_TOOLS.has(b.name)) {
            const input = b.input && typeof b.input === 'object' ? b.input : {}
            const a = { id: bid, role: 'agent', text: clip(input.description || String(input.prompt || '').split('\n')[0], 120),
              agent: clip(input.subagent_type || '', 40), state: 'running', at }
            if (typeof b.id === 'string') agents.set(b.id, a)
            result.messages.push(a)
          } else if (b.type === 'tool_use') {
            countTool(result.messages, bid, at)
          }
        })
      }
    }
  } catch {
    return result
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  result.messages = markSteps(result.messages).slice(-MAX_MESSAGES)
  return result
}

// transcriptImages finds the images of a user turn in a transcript: the entry
// with the message's id, or else the last one with images and the same text
// (the hooks see only the prompt), or else the one closest in time. Pasted
// images are base64 in the transcript, so only lines with one are parsed.
export async function transcriptImages(file, message, maxBytes = 64 << 20) {
  let size
  try {
    size = (await fs.promises.stat(file)).size
  } catch {
    return []
  }
  const input = fs.createReadStream(file, { start: Math.max(0, size - maxBytes), encoding: 'utf8' })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let byId = null
  let byText = null
  let byTime = null
  let gap = 60000
  try {
    for await (const line of lines) {
      if (!line.includes('"image"')) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (!e || e.type !== 'user' || e.isMeta || e.isSidechain || !e.message || !Array.isArray(e.message.content)) continue
      const images = e.message.content.filter((b) => b && b.type === 'image' && b.source && b.source.type === 'base64' && typeof b.source.data === 'string')
      if (!images.length) continue
      if (e.uuid === message.id) {
        byId = images
        break
      }
      if (userText(e.message.content) === message.text) byText = images
      const off = Math.abs((Date.parse(e.timestamp) || 0) - message.at)
      if (off < gap) {
        gap = off
        byTime = images
      }
    }
  } catch {
    return []
  } finally {
    lines.close()
    input.destroy()
  }
  return (byId || byText || byTime || []).map((b) => ({ type: String(b.source.media_type || ''), data: b.source.data }))
}

// tool runs one of macOS's command line tools and answers its output.
const tool = (name, args, timeout = 20000) =>
  new Promise((resolve, reject) => execFile(name, args, { timeout, maxBuffer: 1 << 20 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))))

// shrinkImage makes an image small enough for the car with macOS's sips: a
// JPEG of at most IMAGE_EDGE pixels a side, never larger than it was.
export async function shrinkImage(image, dir) {
  const work = fs.mkdtempSync(path.join(dir, 'image-'))
  try {
    const source = path.join(work, 'source.' + (String(image.type).split('/')[1] || 'img').replace(/[^a-z]/g, ''))
    const target = path.join(work, 'small.jpg')
    fs.writeFileSync(source, Buffer.from(image.data, 'base64'))
    const sizes = [...(await tool('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', source])).matchAll(/pixel(?:Width|Height): *(\d+)/g)].map((m) => Number(m[1]))
    if (sizes.length !== 2 || !(Math.min(...sizes) > 0)) throw new Error('not an image')
    const resize = Math.max(...sizes) > IMAGE_EDGE ? ['-Z', String(IMAGE_EDGE)] : []
    await tool('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', ...resize, source, '--out', target])
    return { type: 'image/jpeg', data: fs.readFileSync(target).toString('base64') }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- speech

// speakable makes Claude's Markdown into text for a voice: code blocks and
// tables are named, in the car's language, not read; marks, bullets and link
// targets go.
export function speakable(text, lang = 'de') {
  const out = []
  let code = false
  let table = false
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      if (!code) out.push(lang === 'en' ? 'Code block skipped.' : 'Codeblock ausgelassen.')
      code = !code
      continue
    }
    if (code) continue
    if (/^\|.*\|$/.test(line)) {
      if (!table) out.push(lang === 'en' ? 'Table skipped.' : 'Tabelle ausgelassen.')
      table = true
      continue
    }
    table = false
    let s = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^-{3,}$/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'Link')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[\s(„"])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?=[\s.,:;!?)“"]|$)/g, '$1$2')
      .replace(/\s*(→|->|=>)\s*/g, ', ')
      .replace(/\s+·\s+/g, ', ')
      .trim()
    if (!s) continue
    if (!/[.!?:;…]$/.test(s)) s += '.'
    out.push(s)
  }
  return out.join('\n')
}

// voiceFor is the voice say speaks the car's language with. German: Anna, else
// the first one for German. English: the first of a few plain voices, never
// the first one listed, which is a novelty voice such as Albert. Else say's
// own choice.
export async function voiceFor(lang) {
  const names = (await tool('say', ['-v', '?']))
    .split('\n')
    .filter((line) => (lang === 'en' ? /\sen_[A-Z]{2}\s/ : /\sde_[A-Z]{2}\s/).test(line))
    .map((line) => line.split(' (')[0].trim())
    .filter(Boolean)
  if (lang === 'en') return ['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa'].find((n) => names.includes(n)) || ''
  return names.includes('Anna') ? 'Anna' : names[0] || ''
}

// speakText makes speech with macOS's say, as AAC at 32 kbit/s: about 4 KB a
// second, so even the longest message stays far below MAX_MEDIA.
export async function speakText(text, voice, dir) {
  const work = fs.mkdtempSync(path.join(dir, 'speech-'))
  try {
    const source = path.join(work, 'text.txt')
    const raw = path.join(work, 'speech.aiff')
    const target = path.join(work, 'speech.m4a')
    fs.writeFileSync(source, text)
    await tool('say', [...(voice ? ['-v', voice] : []), '-f', source, '-o', raw], 120000)
    await tool('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '32000', raw, target], 60000)
    return { type: 'audio/mp4', data: fs.readFileSync(target).toString('base64') }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
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
    this.shrink = options.shrink || shrinkImage
    this.speak = options.speak || speakText
    this.pickVoice = options.voice || voiceFor
    // The voice for each language, once looked up.
    this.voices = new Map()
    // Speech made for the car, by session, message and language.
    this.speeches = new Map()
    // The language of the car's screen, as its long poll last said: what the
    // bridge writes for the car is in it. German until a car says.
    this.carLang = 'de'
    this.later = options.later || ((fn, ms) => setTimeout(fn, ms).unref())
    // Images made small for the car, by session, message and position.
    this.images = new Map()
    this.agentsSource = options.agents || (() => this.runAgents())
    this.spawnClaude = options.spawnClaude || ((args, cwd) => this.runClaude(args, cwd))
    this.projectsDir = options.projectsDir || process.env.COILSHIFT_PROJECTS_DIR || path.join(claudeHome(), 'projects')
    this.registryDir = options.registryDir || process.env.COILSHIFT_SESSIONS_DIR || path.join(claudeHome(), 'sessions')
    this.name = options.name || computerName()
    this.config = this.loadConfig()
    this.sessions = new Map()
    this.relays = new Map()
    this.codes = new Map()
    // Revisions start at the clock, so a restarted bridge is ahead of the one
    // the car last polled and answers its first long poll at once.
    this.rev = Math.floor(this.now())
    this.waiters = []
    this.lastPoll = 0
    this.lastDriving = 0
    this.seq = 0
    this.transcripts = new Map()
    this.redeemed = new Map()
    this.mqtt = null
    this.brokers = []
  }

  // toCar picks the words for the car in its language.
  toCar(de, en) {
    return this.carLang === 'en' ? en : de
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
    // Asked by /coilshift:pair, so its errors are for the Mac.
    if (!this.mqtt) {
      throw fail(409, toMac('Das Internet-Relay ist ausgeschaltet (COILSHIFT_RELAY=off). Bitte über den QR-Code koppeln.',
        'The internet relay is turned off (COILSHIFT_RELAY=off). Please pair with the QR code.'))
    }
    const code = carCode(input)
    if (!code) {
      throw fail(400, toMac('Das ist kein Code aus dem Auto. Er hat 16 Zeichen, etwa K7QM-4ZP2-XR9T-HB3D.',
        'That is not a code from the car. It has 16 characters, like K7QM-4ZP2-XR9T-HB3D.'))
    }
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
      // The voice of say for reading aloud in the car, as `say -v '?'` names it.
      voice: typeof c.voice === 'string' && /^[\p{L}\p{N} ()._-]{1,64}$/u.test(c.voice) ? c.voice : '',
      // Sessions the driver hid in the car, with when: hidden until active again.
      hidden: Object.fromEntries(
        Object.entries(c.hidden && typeof c.hidden === 'object' && !Array.isArray(c.hidden) ? c.hidden : {}).filter(
          ([id, at]) => /^[A-Za-z0-9._:-]{1,128}$/.test(id) && Number.isFinite(at),
        ),
      ),
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
      // messages is what the car sees: the transcript's history (history)
      // with what only the hooks or the car saw so far (extra).
      s = { id, cwd: '', title: '', name: '', kind: 'ended', status: 'ended', updated: this.now(), messages: [], pending: null,
        socket: '', transcript: '', hooked: false, backfilled: false, history: null, synced: '', extra: [] }
      this.sessions.set(id, s)
    }
    return s
  }

  // addMessage keeps what the hooks or the car saw until the transcript has it;
  // keep marks the car's answers and copies it never will.
  addMessage(s, role, text, fields = {}) {
    text = clip(text)
    if (!text) return null
    const m = { id: `m${++this.seq}`, role, text, at: this.now(), ...fields }
    s.extra.push(m)
    this.merge(s)
    return m
  }
  addEntry(s, entry) {
    const m = { id: `m${++this.seq}`, at: this.now(), ...entry }
    s.extra.push(m)
    this.merge(s)
    return m
  }
  addTool(s) {
    if (countTool(s.extra, `m${this.seq + 1}`, this.now())) this.seq++
    this.merge(s)
  }
  // note adds what a notification of background work means, where no
  // transcript tells it.
  note(s, entry) {
    if (entry.event) return this.addEntry(s, { role: 'event', ...entry.event })
    const a = entry.agent
    return this.addEntry(s, { role: 'agent', text: a.name, agent: '', state: a.state,
      ...(a.state === 'running' ? {} : { ended: this.now() }), ...(a.result ? { result: a.result } : {}) })
  }

  // merge puts the history together. A copy from the hooks leaves once the
  // transcript has the same words or has gone past it; the car's prompts once
  // the transcript has them, its answers never.
  merge(s) {
    const history = s.history ? s.history.messages : []
    const key = (m) => `${m.role}\n${squash(m.text)}`
    const said = new Set(history.filter((m) => m.role !== 'tool').map(key))
    const upTo = s.history ? s.history.last : 0
    s.extra = s.extra.filter((m) => {
      if (m.role === 'car') return m.keep || !said.has(key(m))
      if (said.has(key(m))) return false
      return !(history.length && upTo && m.at <= upTo)
    }).slice(-MAX_MESSAGES)
    const all = [...history, ...s.extra].map((m, i) => [m, i])
    all.sort((a, b) => a[0].at - b[0].at || a[1] - b[1])
    s.messages = markSteps(all.map(([m]) => m)).slice(-MAX_MESSAGES)
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

  // sync reads the session's transcript again when it changed; the history
  // comes from it, with every step Claude takes. Answers whether it read the
  // file, so the caller can publish a new revision.
  sync(s) {
    if (!s.transcript) s.transcript = this.findTranscript(s.id)
    if (!s.transcript) return false
    let stat
    try {
      stat = fs.statSync(s.transcript)
    } catch {
      return false
    }
    const mark = `${stat.size}:${stat.mtimeMs}`
    if (s.synced === mark) return false
    const t = parseTranscript(s.transcript)
    s.synced = mark
    s.backfilled = true
    s.history = t
    if (t.title && !s.title) s.title = t.title
    if (!s.cwd) s.cwd = t.cwd
    const last = t.messages.length ? t.messages[t.messages.length - 1].at : 0
    if (!s.hooked && last) s.updated = Math.max(s.updated, last)
    this.merge(s)
    return true
  }

  // A transcript also changes between hooks: Claude's words before a long
  // tool call, a sub-agent's end, and every step of a session without the
  // plugin's hooks. A change wakes the car's long poll like a hook would.
  refreshTranscripts() {
    let changed = false
    for (const s of [...this.sessions.values()].sort((a, b) => b.updated - a.updated).slice(0, MAX_SESSIONS)) {
      if (this.sync(s)) changed = true
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
      title: clip(s.title || s.name || path.basename(s.cwd || '') || this.toCar('Sitzung', 'Session'), 120),
      cwd: s.cwd,
      kind: s.kind,
      status: s.pending ? 'waiting' : s.status,
      updated: Math.floor(s.updated),
      delivery: this.delivery(s),
      pending: p
        ? { id: p.id, kind: p.kind, title: p.title, text: p.text, tool: p.tool || '', detail: p.detail || '', questions: p.questions || [], since: p.since }
        : undefined,
      messages: s.messages.map(Bridge.shown),
    }
  }

  // shown is a message as the car gets it, without the bridge's own marks.
  static shown(m) {
    const out = { id: m.id, role: m.role, text: m.text, at: m.at }
    for (const k of ['count', 'images', 'step', 'kind', 'state', 'exit', 'agent', 'ended', 'result']) if (m[k] !== undefined) out[k] = m[k]
    return out
  }

  // image is one image of a user's message, made small for the car. The
  // transcript is read once per image; the result stays for the next request.
  async image(session, message, n) {
    const s = this.sessions.get(session)
    const m = s && s.messages.find((x) => x.id === message && x.role === 'user')
    if (!m || !Number.isInteger(n) || n < 0 || n >= (m.images || 0)) throw fail(404, this.toCar('Dieses Bild kennt der Mac nicht.', 'The Mac does not know this image.'))
    const key = `${s.id}\n${m.id}\n${n}`
    let job = this.images.get(key)
    if (job) {
      this.images.delete(key)
    } else {
      job = (async () => {
        if (!s.transcript) s.transcript = this.findTranscript(s.id)
        const image = (await transcriptImages(s.transcript, m))[n]
        if (!image || image.data.length > MAX_IMAGE_SOURCE) throw fail(404, this.toCar('Das Bild ist nicht mehr im Verlauf.', 'The image is no longer in the history.'))
        try {
          return await this.shrink(image, this.dir)
        } catch {
          // Without sips a small original still goes.
          if (IMAGE_TYPES.has(image.type) && image.data.length <= MAX_MEDIA) return image
          throw fail(422, this.toCar('Das Bild lässt sich nicht verkleinern.', 'The image cannot be made smaller.'))
        }
      })()
      job.catch(() => this.images.get(key) === job && this.images.delete(key))
    }
    this.images.set(key, job)
    while (this.images.size > 16) this.images.delete(this.images.keys().next().value)
    const out = await job
    if (!IMAGE_TYPES.has(out.type) || out.data.length > MAX_MEDIA) throw fail(413, this.toCar('Das Bild ist zu groß für das Auto.', 'The image is too large for the car.'))
    return out
  }

  // speech is one of Claude's answers read aloud on the Mac, made once; the
  // car plays it. The voice is config.voice, else one for the car's language
  // as say has it.
  async speech(session, message) {
    const s = this.sessions.get(session)
    const m = s && s.messages.find((x) => x.id === message && x.role === 'assistant')
    if (!m) throw fail(404, this.toCar('Diese Antwort kennt der Mac nicht.', 'The Mac does not know this answer.'))
    const lang = this.carLang
    const text = speakable(m.text, lang)
    if (!text) throw fail(404, this.toCar('In dieser Antwort gibt es nichts vorzulesen.', 'There is nothing to read aloud in this answer.'))
    const key = `${s.id}\n${m.id}\n${lang}`
    let job = this.speeches.get(key)
    if (job) {
      this.speeches.delete(key)
    } else {
      job = (async () => {
        if (!this.config.voice && !this.voices.has(lang)) this.voices.set(lang, await this.pickVoice(lang).catch(() => ''))
        return this.speak(text, this.config.voice || this.voices.get(lang), this.dir)
      })()
      job.catch(() => this.speeches.get(key) === job && this.speeches.delete(key))
    }
    this.speeches.set(key, job)
    while (this.speeches.size > 8) this.speeches.delete(this.speeches.keys().next().value)
    let out
    try {
      out = await job
    } catch {
      throw fail(422, this.toCar('Der Mac kann gerade nicht vorlesen.', 'The Mac cannot read aloud right now.'))
    }
    if (out.type !== 'audio/mp4' || out.data.length > MAX_MEDIA) throw fail(413, this.toCar('Die Antwort ist zu lang zum Vorlesen.', 'The answer is too long to read aloud.'))
    return out
  }

  // quiet says whether a session has nothing for the car yet: it ended without
  // a word with Claude, or it is new and has none for less than a minute.
  // Tools such as CodexBar start sessions every half hour that only run
  // "/usage" or wait half a minute. A held prompt is never quiet, and history
  // not read yet counts as words.
  quiet(s) {
    if (s.pending || talked(s.messages)) return false
    if (s.kind === 'ended') return Boolean(s.hooked || s.backfilled)
    return this.now() - (s.startedAt || 0) < QUIET_START
  }

  projects() {
    const seen = new Set()
    const list = []
    for (const s of [...this.sessions.values()].filter((s) => !this.quiet(s)).sort((a, b) => b.updated - a.updated)) {
      if (!s.cwd || seen.has(s.cwd) || list.length >= 12) continue
      seen.add(s.cwd)
      list.push({ cwd: s.cwd, title: path.basename(s.cwd) || s.cwd })
    }
    return list
  }

  snapshot() {
    // Hidden in the car until something happens there again.
    const hidden = (s) => (this.config.hidden[s.id] || 0) >= s.updated
    const shown = [...this.sessions.values()].filter((s) => !s.archived && !this.quiet(s))
    const list = shown.filter((s) => !hidden(s)).sort((a, b) => b.updated - a.updated).slice(0, MAX_SESSIONS)
    let read = false
    for (const s of list) read = this.sync(s) || read
    // New history is a new revision, or the car would keep its old copy.
    if (read) this.touch()
    return {
      rev: this.rev,
      bridge: { name: this.name, version: VERSION, away: this.away() },
      sessions: list.filter((s) => s.kind !== 'ended' || talked(s.messages)).map((s) => this.view(s)),
      projects: this.projects(),
      hidden: shown.filter(hidden).length,
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

  // settle ends a question or permission nobody holds once Claude takes the
  // next step: a dialog is over when another tool ran, the turn ended or a new
  // prompt came. A question that was rejected or turned into a clarification
  // never reaches a PostToolUse of its own.
  settle(s) {
    if (s.pending && !s.pending.waiter && s.pending.kind !== 'input') s.pending = null
  }

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
        this.sync(s)
        // A new session without a word joins the car's list after a minute.
        s.startedAt = this.now()
        if (!talked(s.messages)) this.later(() => this.sessions.get(s.id) === s && s.kind !== 'ended' && !talked(s.messages) && this.touch(), QUIET_START)
        break
      case 'UserPromptSubmit': {
        if (s.pending && !s.pending.waiter) s.pending = null
        s.status = 'working'
        this.sync(s)
        const turn = userTurn(input.prompt)
        if (turn.notes) {
          // Background work that ended: from the transcript, or here without one.
          if (!s.history) for (const n of turn.notes) this.note(s, noteEntry(n))
          break
        }
        // A prompt from the car is already its message.
        const known = (m) => m.role === turn.role && squash(m.text) === squash(turn.text)
        if (turn.role === 'car' && s.messages.some(known)) break
        const m = this.addMessage(s, turn.role, turn.text)
        if (m && turn.role === 'user' && imageCount(turn.text)) m.images = imageCount(turn.text)
        break
      }
      case 'PreToolUse': {
        s.status = 'working'
        if (input.tool_name !== 'AskUserQuestion') break
        const questions = (input.tool_input && Array.isArray(input.tool_input.questions) ? input.tool_input.questions : []).slice(0, 4)
        const prompt = this.newPrompt('question', {
          title: this.toCar('Claude fragt', 'Claude asks'),
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
        // The dialog of AskUserQuestion is the question PreToolUse already
        // showed, not a permission; it must not replace it in the car.
        if (input.tool_name === 'AskUserQuestion') break
        const toolName = clip(input.tool_name, 64)
        const prompt = this.newPrompt('permission', {
          title: this.toCar('Freigabe', 'Approval'),
          tool: toolName,
          detail: clip(toolSummary(input.tool_name, input.tool_input).replace(/^[^:]*:\s*/, ''), 1000),
          text: this.toCar(`Claude möchte ${toolName} ausführen.`, `Claude wants to run ${toolName}.`),
        })
        this.release(s)
        s.pending = prompt
        s.status = 'waiting'
        if (this.away() || s.kind === 'background') return this.hold(s, prompt, res)
        break
      }
      case 'PostToolUse':
        // A sub-agent's own call (agent_id) is its work, not the session's
        // next step: an open question stays, and its calls are not counted.
        if (input.agent_id) break
        this.settle(s)
        // With a transcript the call is in it already.
        if (!this.sync(s) && !s.history) this.addTool(s)
        s.status = 'working'
        break
      case 'Notification':
        if (input.notification_type === 'idle_prompt' && !s.pending) s.status = 'waiting'
        break
      case 'Stop': {
        this.settle(s)
        this.sync(s)
        const text = clip(input.last_assistant_message)
        if (text && !s.messages.some((m) => m.role === 'assistant' && squash(m.text) === squash(text))) this.addMessage(s, 'assistant', text)
        s.status = 'idle'
        const question = closingQuestion(text)
        if (question && !s.pending) s.pending = this.newPrompt('input', { title: this.toCar('Claude wartet auf dich', 'Claude is waiting for you'), text: question })
        break
      }
      case 'SessionEnd':
        this.release(s)
        s.kind = 'ended'
        s.status = 'ended'
        // Without a word and without a transcript there is nothing to keep.
        if (!talked(s.messages) && !(s.transcript && fs.existsSync(s.transcript))) this.sessions.delete(s.id)
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
    if (!relay) {
      throw fail(422, this.toCar('Diese Sitzung läuft ohne CoilShift-Relay, vermutlich seit vor der Plugin-Installation. Bitte die Sitzung neu starten.',
        'This session runs without the CoilShift relay, probably since before the plugin was installed. Please restart the session.'))
    }
    const id = `d${++this.seq}`
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        relay.results.delete(id)
        reject(fail(504, this.toCar('Die Sitzung hat die Nachricht nicht rechtzeitig angenommen.', 'The session did not take the message in time.')))
      }, 8000)
      relay.results.set(id, (ok, error) => {
        clearTimeout(timer)
        const why = clip(error || this.toCar('unbekannt', 'unknown'), 120)
        ok ? resolve() : reject(fail(502, this.toCar('Die Sitzung hat die Nachricht abgelehnt: ', 'The session refused the message: ') + why))
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
      if (!fs.existsSync(cwd)) return reject(fail(422, this.toCar('Der Projektordner existiert auf dem Mac nicht mehr: ', 'The project folder no longer exists on the Mac: ') + clip(cwd, 200)))
      execFile(this.claude, args, { cwd, timeout: 60000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`
        const m = /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(out)
        if (m) return resolve(m[1])
        const reason = clip(out.split('\n').find((l) => l.trim()) || (error && error.message) || 'claude failed', 300)
        reject(fail(422, this.toCar('Claude Code auf dem Mac: ', 'Claude Code on the Mac: ') + reason))
      })
    })
  }

  // fromCar marks text from the car for Claude, in the car's language: the
  // driver wrote or spoke in it.
  static fromCar(text, source, lang = 'de') {
    const mark = lang === 'en'
      ? (source === 'voice' ? '[From the car, dictated by voice]' : '[From the car]')
      : (source === 'voice' ? '[Aus dem Auto, per Sprache diktiert]' : '[Aus dem Auto]')
    return `${mark} ${text}`
  }

  // reply: {session, prompt?, text?, answers?, decision?, source}
  async reply(r) {
    const s = this.sessions.get(r.session)
    if (!s) throw fail(404, this.toCar('Diese Sitzung kennt der Mac nicht mehr.', 'The Mac no longer knows this session.'))
    const text = clip(r.text)
    const answers = r.answers && typeof r.answers === 'object' ? r.answers : {}
    if (r.prompt) {
      const p = s.pending
      if (!p || p.id !== r.prompt) throw fail(409, this.toCar('Die Frage ist bereits beantwortet oder abgelaufen.', 'The question was already answered or has expired.'))
      if (p.waiter) {
        if (p.kind === 'question') {
          // Keys are the questions as the car shows them; the hook needs the originals.
          const out = {}
          for (const [key, value] of Object.entries(answers)) {
            const i = p.questions.findIndex((q) => squash(q.question) === squash(key) || squash(q.question).startsWith(squash(key)))
            if (i >= 0 && typeof value === 'string' && value.trim()) out[p.originals[i]] = clip(value, 1000)
          }
          if (Object.keys(out).length === 0 && text && p.originals[0]) out[p.originals[0]] = text
          if (Object.keys(out).length === 0) throw fail(400, this.toCar('Bitte eine Antwort wählen oder sprechen.', 'Please choose or speak an answer.'))
          this.addMessage(s, 'car', Object.entries(out).map(([q, a]) => `${q} → ${a}`).join('\n'), { keep: true })
          p.waiter(Bridge.questionOutput(p, out))
        } else if (p.kind === 'permission') {
          const allow = r.decision === 'allow'
          const message = text || this.toCar('Im Auto abgelehnt.', 'Denied in the car.')
          const said = allow ? this.toCar('Freigegeben', 'Approved') : this.toCar('Abgelehnt', 'Denied')
          this.addMessage(s, 'car', `${said}: ${p.tool}${!allow && text ? ' · ' + text : ''}`, { keep: true })
          p.waiter({
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message },
            },
          })
        }
        return { ok: true, delivered: 'hook' }
      }
      if (p.kind !== 'input') {
        throw fail(422, this.toCar('Die Frage ist im Terminal offen. Mit eingeschaltetem Unterwegs-Modus lassen sich künftige Fragen im Auto beantworten.',
          'The question is open in the terminal. With away mode on, future questions can be answered in the car.'))
      }
    }
    if (!text) throw fail(400, this.toCar('Bitte einen Text eingeben oder diktieren.', 'Please type or dictate a text.'))
    const message = Bridge.fromCar(text, r.source, this.carLang)
    if (this.delivery(s) === 'inbox') {
      await this.deliverInbox(s, message)
      if (s.pending && s.pending.kind === 'input') s.pending = null
      this.addMessage(s, 'car', text)
      s.status = 'working'
      s.updated = this.now()
      this.touch()
      return { ok: true, delivered: 'inbox' }
    }
    if (!s.cwd) throw fail(422, this.toCar('Für diese Sitzung ist kein Projektordner bekannt.', 'No project folder is known for this session.'))
    if (s.kind !== 'ended') {
      // The session keeps running in its terminal; a copy with its history
      // takes the text and works on in the background.
      const id = await this.spawnClaude(['--bg', '--resume', s.id, '--fork-session', ...this.permissionArgs(), message], s.cwd)
      if (s.pending && s.pending.kind === 'input') s.pending = null
      this.addMessage(s, 'car', text, { keep: true })
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
    if (!this.projects().some((p) => p.cwd === cwd) || !text) throw fail(400, this.toCar('Projekt oder Auftrag ungültig.', 'Invalid project or task.'))
    const name = clip(`${this.toCar('Auto', 'Car')} · ${text.split('\n')[0]}`, 48)
    const id = await this.spawnClaude(['--bg', '-n', name, ...this.permissionArgs(), Bridge.fromCar(text, body.source, this.carLang)], cwd)
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
    if (hosts.length === 0) throw new Error(toMac('keine LAN- oder Tailscale-Adresse', 'no LAN or Tailscale address'))
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
        return info ? reply(200, info) : reply(410, { error: 'relay_off', message: this.toCar('Das Internet-Relay ist auf dem Mac ausgeschaltet.', 'The internet relay is turned off on the Mac.') })
      }
      if (method === 'GET' && url.pathname === '/v1/state') {
        const since = Number(url.searchParams.get('since'))
        const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait')) || 0))
        const gear = url.searchParams.get('gear') || ''
        // The car's language; one that changes is a new revision, so the car
        // gets the words in it at once. A car that names none keeps the last.
        const lang = url.searchParams.get('lang')
        if ((lang === 'de' || lang === 'en') && lang !== this.carLang) {
          this.carLang = lang
          this.touch()
        }
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
      if (method === 'GET' && url.pathname === '/v1/image') {
        const n = Number(url.searchParams.get('n') || 0)
        return reply(200, await this.image(url.searchParams.get('session'), url.searchParams.get('message'), n))
      }
      if (method === 'GET' && url.pathname === '/v1/speech') {
        return reply(200, await this.speech(url.searchParams.get('session'), url.searchParams.get('message')))
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
      if (method === 'POST' && url.pathname === '/v1/hide') {
        const id = typeof body.session === 'string' ? body.session : ''
        if (!this.sessions.has(id)) return reply(404, { error: 'unknown', message: this.toCar('Diese Sitzung kennt der Mac nicht mehr.', 'The Mac no longer knows this session.') })
        for (const [old, at] of Object.entries(this.config.hidden)) {
          if (!this.sessions.has(old) && this.now() - at > 7 * 24 * 3600 * 1000) delete this.config.hidden[old]
        }
        this.config.hidden[id] = this.now()
        this.saveConfig()
        this.touch()
        return reply(200, { ok: true })
      }
      if (method === 'POST' && url.pathname === '/v1/unhide') {
        this.config.hidden = {}
        this.saveConfig()
        this.touch()
        return reply(200, { ok: true })
      }
      if (method === 'POST' && url.pathname === '/v1/unpair') {
        this.forget([device])
        return reply(200, { ok: true })
      }
    } catch (error) {
      return reply(error.status || 500, { error: 'failed', message: error.status ? clip(error.message, 300) : this.toCar('Interner Fehler der Bridge.', 'Internal error of the bridge.') })
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

const RELAY_STATE = {
  de: { up: 'verbunden', connecting: 'verbindet', down: 'getrennt', idle: 'wartet' },
  en: { up: 'connected', connecting: 'connecting', down: 'disconnected', idle: 'waiting' },
}

// pairCar sends the pairing to the car that shows code and waits until it has
// paired (the car keeps its pairing window open for ten minutes).
async function pairCar(dir, code) {
  const before = new Set(((await local(dir, 'GET', '/status')).body.devices || []).map((d) => d.id))
  const answer = await local(dir, 'POST', '/pair/car', { code })
  if (answer.status !== 200) return console.log(toMac('Keine Kopplung: ', 'No pairing: ') + ((answer.body && answer.body.message) || toMac('unbekannter Fehler', 'unknown error')))
  console.log(toMac('Die Kopplung geht über das Internet-Relay ans Auto, Ende-zu-Ende-verschlüsselt. Warte auf das Auto …',
    'The pairing goes to the car through the internet relay, end-to-end encrypted. Waiting for the car …'))
  const deadline = Date.now() + 90 * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const { body } = await local(dir, 'GET', '/status')
    const added = (body.devices || []).find((d) => !before.has(d.id))
    if (added) return console.log(toMac(`Gekoppelt mit ${added.name}. Die Claude-App im Auto zeigt jetzt deine Sitzungen.`, `Paired with ${added.name}. The Claude app in the car now shows your sessions.`))
  }
  console.log(
    toMac(
      [
        'Das Auto hat sich noch nicht gemeldet. Das Angebot gilt noch drei Minuten.',
        'Bitte prüfen: Ist die Claude-App im Auto mit dem Kopplungscode offen, stimmt der Code, und hat das Auto Internet?',
        'Danach mit /coilshift:status nachsehen, ob das Auto gekoppelt ist.',
      ],
      [
        'The car has not answered yet. The offer stays open for three more minutes.',
        'Please check: is the Claude app open in the car with the pairing code, is the code right, and does the car have internet?',
        'Then check with /coilshift:status whether the car is paired.',
      ],
    ).join('\n'),
  )
}

async function cli() {
  const [command, ...args] = process.argv.slice(2).filter((a, i, all) => a !== '--data' && all[i - 1] !== '--data')
  const dir = dataDir()
  const lang = macLang()
  // Dates as the Mac writes them: German ones in German, else the Mac's own.
  const locale = lang === 'de' ? 'de-DE' : undefined
  switch (command) {
    case 'serve':
      return serve(dir)
    case 'pair': {
      if (!(await ensureBridge(dir))) return console.log(toMac('Die Bridge startet nicht. Details: ', 'The bridge does not start. Details: ') + path.join(dir, 'bridge.log'))
      if (args.join('').trim()) return pairCar(dir, args.join(''))
      const answer = await local(dir, 'POST', '/pair/new', {})
      if (answer.status !== 200) return console.log(toMac('Kein Kopplungslink: ', 'No pairing link: ') + ((answer.body && answer.body.message) || toMac('unbekannter Fehler', 'unknown error')))
      let copied = false
      try {
        execFileSync('/usr/bin/pbcopy', { input: answer.body.link })
        copied = true
      } catch {}
      const hosts = answer.body.hosts.join(', ')
      const relay = answer.body.link.includes('&r=')
      console.log(
        toMac(
          [
            'Kopplungslink (gültig 10 Minuten, nur einmal verwendbar):',
            '',
            answer.body.link,
            '',
            copied ? 'Der Link ist in der Zwischenablage, per Universal Clipboard auch auf dem iPhone.' : '',
            'So geht es weiter:',
            '1. Im Auto die Claude-App öffnen und den QR-Code mit dem Handy scannen.',
            '2. Auf der Handy-Seite den Link einfügen und »Koppeln« tippen.',
            `Das Auto versucht zuerst ${hosts} (Tailscale vor WLAN)${relay ? ', sonst das Internet-Relay' : ''}.`,
            'Ohne gemeinsames WLAN: den Code aus der Claude-App im Auto hier angeben, also /coilshift:pair <Code>.',
          ],
          [
            'Pairing link (valid for 10 minutes, usable once):',
            '',
            answer.body.link,
            '',
            copied ? 'The link is on the clipboard, and through Universal Clipboard on the iPhone too.' : '',
            'Next:',
            '1. Open the Claude app in the car and scan the QR code with your phone.',
            '2. Paste the link on the phone page and tap “Pair”.',
            `The car tries ${hosts} first (Tailscale before Wi-Fi)${relay ? ', then the internet relay' : ''}.`,
            'Without a shared Wi-Fi: give the code from the Claude app in the car here, as /coilshift:pair <code>.',
          ],
        )
          .filter((l) => l !== null)
          .join('\n'),
      )
      return
    }
    case 'status': {
      if (!(await running(dir))) return console.log(toMac('Die Bridge läuft nicht. Sie startet mit der nächsten Claude-Code-Sitzung.', 'The bridge is not running. It starts with the next Claude Code session.'))
      const { body } = await local(dir, 'GET', '/status')
      const states = RELAY_STATE[lang]
      const relays = (body.mqtt || []).map((b) => `${b.broker} ${states[b.state] || b.state}${b.error && b.state !== 'up' ? ' (' + b.error + ')' : ''}`).join(', ')
      const cars = body.devices
        .map((d) => `${d.name} (${toMac('zuletzt', 'last seen')} ${new Date(d.seen).toLocaleString(locale)}${d.relay ? toMac(', mit Internet-Relay', ', with internet relay') : ''})`)
        .join(', ')
      const lines = [
        toMac(`CoilShift-Bridge ${body.version} auf ${body.name}, Port ${body.port}`, `CoilShift bridge ${body.version} on ${body.name}, port ${body.port}`),
        `${toMac('Adressen', 'Addresses')}: ${body.hosts.join(', ') || toMac('keine LAN-/Tailscale-Adresse', 'no LAN or Tailscale address')}`,
        `${toMac('Internet-Relay', 'Internet relay')}: ${relays || toMac('aus', 'off')}`,
        `${toMac('Unterwegs-Modus', 'Away mode')}: ${body.away}${body.awayNow ? toMac(' (gerade aktiv)', ' (active now)') : ''}`,
        `${toMac('Gekoppelte Autos', 'Paired cars')}: ${cars || toMac('keine', 'none')}`,
        `${toMac('Letzte Abfrage des Autos', "The car's last poll")}: ${body.lastPoll ? new Date(body.lastPoll).toLocaleString(locale) : toMac('noch keine', 'none yet')}`,
        `${toMac('Sitzungen mit Relay', 'Sessions with relay')}: ${body.relays}`,
        ...body.devices
          .filter((d) => d.diag)
          .flatMap((d) => [
            `${toMac('Diagnose von', 'Diagnostics from')} ${d.name} (${d.diag.version || '?'}, ${new Date(d.diag.at).toLocaleTimeString(locale)}):`,
            ...Object.entries(d.diag.values).map(([k, v]) => `  ${k}: ${v}`),
          ]),
        ...body.sessions.slice(0, 10).map((s) => `  · ${s.title} — ${s.kind}, ${s.status}${s.delivery ? toMac(', Antwort per ', ', answer by ') + s.delivery : ''}`),
      ]
      return console.log(lines.join('\n'))
    }
    case 'away': {
      const mode = args[0]
      if (!['on', 'off', 'auto'].includes(mode)) return console.log(toMac('Aufruf: away on|off|auto', 'Usage: away on|off|auto'))
      if (!(await ensureBridge(dir))) return console.log(toMac('Die Bridge startet nicht.', 'The bridge does not start.'))
      await local(dir, 'POST', '/away', { mode })
      return console.log(`${toMac('Unterwegs-Modus', 'Away mode')}: ${mode}`)
    }
    case 'unpair':
      if (!(await running(dir))) return console.log(toMac('Die Bridge läuft nicht.', 'The bridge is not running.'))
      await local(dir, 'POST', '/unpair', {})
      return console.log(toMac('Alle Autos entkoppelt.', 'All cars unpaired.'))
    case 'stop':
      if (!(await running(dir))) return console.log(toMac('Die Bridge läuft nicht.', 'The bridge is not running.'))
      await local(dir, 'POST', '/stop', {}).catch(() => {})
      return console.log(toMac('Bridge gestoppt.', 'Bridge stopped.'))
    default:
      console.log(toMac('Aufruf: coilshift-bridge.mjs serve|pair [Code]|status|away on|off|auto|unpair|stop [--data DIR]',
        'Usage: coilshift-bridge.mjs serve|pair [code]|status|away on|off|auto|unpair|stop [--data DIR]'))
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) cli()

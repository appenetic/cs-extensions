import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Bridge, allowedPeer, bridgeHosts, closingQuestion, parseTranscript, toolSummary, userText } from '../bin/coilshift-bridge.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csb-'))
}

function bridge(options = {}) {
  const dir = tmp()
  const projects = path.join(dir, 'projects')
  fs.mkdirSync(projects)
  let now = 1_800_000_000_000
  const b = new Bridge(dir, {
    name: 'Testmac',
    projectsDir: projects,
    now: () => now,
    spawnClaude: options.spawnClaude || (async () => 'abcdef12'),
    agents: async () => options.agents || [],
  })
  b.advance = (ms) => (now += ms)
  return b
}

test('transcript backfill skips thinking, sidechains and system reminders', () => {
  const dir = tmp()
  const file = path.join(dir, 's.jsonl')
  const lines = [
    { type: 'ai-title', aiTitle: 'Kachel bauen' },
    { type: 'user', uuid: 'u1', cwd: '/p', timestamp: '2026-11-17T10:00:00Z', message: { role: 'user', content: '<command-name>/goal</command-name><command-args>baue die App</command-args>' } },
    { type: 'user', uuid: 'u2', isMeta: true, message: { role: 'user', content: 'Caveat' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Mache ich.' }, { type: 'tool_use', name: 'Bash', input: { command: 'go test ./...\nmore' } }] } },
    { type: 'assistant', uuid: 'a2', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', uuid: 'u4', message: { role: 'user', content: 'Weiter <system-reminder>intern</system-reminder>' } },
  ]
  fs.writeFileSync(file, 'not json\n' + lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const t = parseTranscript(file)
  assert.equal(t.title, 'Kachel bauen')
  assert.equal(t.cwd, '/p')
  assert.deepEqual(
    t.messages.map((m) => [m.role, m.text]),
    [
      ['user', '/goal baue die App'],
      ['assistant', 'Mache ich.'],
      ['tool', 'Bash: go test ./...'],
      ['user', 'Weiter'],
    ],
  )
  assert.equal(JSON.stringify(t).includes('secret'), false)
})

test('helpers', () => {
  assert.equal(userText('hi <local-command-stdout>x</local-command-stdout>'), 'hi')
  assert.equal(toolSummary('Edit', { file_path: '/a/b.go' }), 'Edit: /a/b.go')
  assert.equal(closingQuestion('Fertig.\n\nSoll ich weitermachen?'), 'Soll ich weitermachen?')
  assert.equal(closingQuestion('Fertig. Was meinst du? Ich habe es erledigt.'), '')
  for (const ok of ['127.0.0.1', '::ffff:192.168.1.5', '10.1.2.3', '100.100.1.2', 'fd7a:115c:a1e0::1', '::1']) assert.ok(allowedPeer(ok), ok)
  for (const bad of ['8.8.8.8', '::ffff:1.1.1.1', '2001:db8::1', '100.128.0.1', '']) assert.ok(!allowedPeer(bad), bad)
  assert.deepEqual(
    bridgeHosts({
      en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
      utun4: [{ family: 'IPv4', address: '100.84.12.7', internal: false }],
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      pdp_ip0: [{ family: 'IPv4', address: '100.70.1.1', internal: false }],
    }),
    ['100.84.12.7', '192.168.1.20'],
  )
})

test('a question in the terminal is shown but not held unless away', async () => {
  const b = bridge()
  const res = { on() {} }
  assert.deepEqual(await b.hook({ session_id: 's1', hook_event_name: 'SessionStart', cwd: '/p' }, res), {})
  const out = await b.hook({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } }, res)
  assert.deepEqual(out, {})
  const s = b.snapshot().sessions[0]
  assert.equal(s.pending.kind, 'question')
  assert.equal(s.delivery, '')
  await assert.rejects(b.reply({ session: 's1', prompt: s.pending.id, answers: { 'Q?': 'A' }, source: 'touch' }), (e) => e.status === 422)
  await b.hook({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {} }, res)
  assert.equal(b.snapshot().sessions[0].pending, undefined)
})

test('a background session holds a permission until the car decides', async () => {
  const b = bridge({ agents: [{ sessionId: 's2', cwd: '/p', kind: 'background', state: 'blocked' }] })
  await b.discover()
  const res = { on() {} }
  const pending = b.hook({ session_id: 's2', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm publish' } }, res)
  const s = b.snapshot().sessions[0]
  assert.equal(s.kind, 'background')
  assert.equal(s.delivery, 'hook')
  assert.equal(s.pending.detail, 'npm publish')
  const result = await b.reply({ session: 's2', prompt: s.pending.id, decision: 'deny', text: 'Nicht veröffentlichen', source: 'card' })
  assert.equal(result.delivered, 'hook')
  assert.deepEqual(await pending, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Nicht veröffentlichen' } } })
  assert.equal(b.snapshot().sessions[0].messages.at(-1).text, 'Abgelehnt: Bash · Nicht veröffentlichen')
})

test('a held question ends when the hook goes away', async () => {
  const b = bridge()
  b.config.away = 'on'
  let close
  const res = { on: (event, fn) => event === 'close' && (close = fn) }
  const pending = b.hook({ session_id: 's3', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?', options: [] }] } }, res)
  assert.equal(b.snapshot().sessions[0].delivery, 'hook')
  close()
  assert.deepEqual(await pending, {})
  assert.equal(b.snapshot().sessions[0].pending, undefined)
})

test('away follows driving in auto mode', async () => {
  const b = bridge()
  assert.equal(b.away(), false)
  b.lastDriving = b.now()
  assert.equal(b.away(), true)
  b.advance(6 * 60 * 1000)
  assert.equal(b.away(), false)
  b.config.away = 'off'
  b.lastDriving = b.now()
  assert.equal(b.away(), false)
})

test('discovery ends sessions it no longer lists and maps states', async () => {
  let list = [
    { sessionId: 'a', cwd: '/a', kind: 'interactive', pid: 1, status: 'idle', name: 'a-1' },
    { sessionId: 'b', cwd: '/b', kind: 'background', state: 'done' },
  ]
  const b = bridge({ agents: undefined })
  b.agentsSource = async () => list
  await b.discover()
  assert.equal(b.sessions.get('a').kind, 'interactive')
  assert.equal(b.sessions.get('b').kind, 'ended')
  list = null
  await b.discover()
  assert.equal(b.sessions.get('a').kind, 'interactive', 'a failed listing changes nothing')
  list = []
  await b.discover()
  assert.equal(b.sessions.get('a').kind, 'ended')
  assert.equal(Bridge.status('busy'), 'working')
  assert.equal(Bridge.status('blocked'), 'waiting')
})

test('replies: unknown session, text without relay, resume with the project folder', async () => {
  const calls = []
  const b = bridge({ spawnClaude: async (args, cwd) => calls.push([args, cwd]) && 'abcdef12' })
  await assert.rejects(b.reply({ session: 'nope', text: 'x', source: 'touch' }), (e) => e.status === 404)
  await b.hook({ session_id: 's4', hook_event_name: 'SessionStart', cwd: '/p' }, { on() {} })
  await b.hook({ session_id: 's4', hook_event_name: 'UserPromptSubmit', prompt: 'Los' }, { on() {} })
  await assert.rejects(b.reply({ session: 's4', text: 'x', source: 'touch' }), (e) => e.status === 422 && /Relay/.test(e.message))
  await b.hook({ session_id: 's4', hook_event_name: 'SessionEnd', reason: 'other' }, { on() {} })
  assert.equal(b.snapshot().sessions[0].delivery, 'resume')
  const result = await b.reply({ session: 's4', text: 'Weiter', source: 'voice' })
  assert.equal(result.delivered, 'resume')
  assert.deepEqual(calls, [[['--bg', '--resume', 's4', '[Aus dem Auto, per Sprache diktiert] Weiter'], '/p']])
  b.config.permission_mode = 'bypassPermissions'
  await b.start({ cwd: '/p', text: 'Neue Idee', source: 'touch' })
  assert.deepEqual(calls[1], [['--bg', '-n', 'Auto · Neue Idee', '--dangerously-skip-permissions', '[Aus dem Auto] Neue Idee'], '/p'])
  await assert.rejects(b.start({ cwd: '/etc', text: 'x' }), (e) => e.status === 400)
})

test('pairing codes are single use and expire; tokens are stored hashed', () => {
  const b = bridge()
  const { link } = b.pairingLink('f'.repeat(64), ['100.1.2.3', '192.168.1.2'])
  const url = new URL(link)
  const params = new URLSearchParams(url.hash.slice(1))
  assert.equal(url.host, '100.1.2.3:47621')
  assert.equal(params.get('h'), '192.168.1.2')
  assert.equal(params.get('n'), 'Testmac')
  const token = b.redeem(params.get('c'), 'Tesla Model Y')
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(b.redeem(params.get('c'), 'again'), null)
  const saved = fs.readFileSync(path.join(b.dir, 'config.json'), 'utf8')
  assert.equal(saved.includes(token), false)
  assert.equal((fs.statSync(path.join(b.dir, 'config.json')).mode & 0o777).toString(8), '600')
  assert.ok(b.device('Bearer ' + token))
  assert.equal(b.device('Bearer ' + '0'.repeat(64)), null)
  const late = b.pairingLink('f'.repeat(64), ['127.0.0.1'])
  b.advance(11 * 60 * 1000)
  assert.equal(b.redeem(new URLSearchParams(new URL(late.link).hash.slice(1)).get('c'), 'x'), null)
})

test('a session without hooks follows its transcript with a new revision', () => {
  const b = bridge()
  const project = path.join(b.projectsDir, '-p')
  fs.mkdirSync(project)
  const id = '12345678-1234-1234-1234-123456789abc'
  const file = path.join(project, id + '.jsonl')
  const line = (uuid, text) => JSON.stringify({ type: 'assistant', uuid, cwd: '/p', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  fs.writeFileSync(file, line('a1', 'Erster Stand'))
  // The bridge's clock is fixed in these tests; the file is as recent as it is.
  fs.utimesSync(file, new Date(b.now()), new Date(b.now()))
  b.scanTranscripts()
  const first = b.snapshot()
  assert.deepEqual(first.sessions[0].messages.map((m) => m.text), ['Erster Stand'])
  assert.equal(b.snapshot().rev, first.rev, 'an unchanged file is no new revision')
  fs.appendFileSync(file, line('a2', 'Neuer Stand'))
  const later = new Date(b.now() + 5000)
  fs.utimesSync(file, later, later)
  b.refreshTranscripts()
  const next = b.snapshot()
  assert.ok(next.rev > first.rev)
  assert.deepEqual(next.sessions[0].messages.map((m) => m.text), ['Erster Stand', 'Neuer Stand'])
})

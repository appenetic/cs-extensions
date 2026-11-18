import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import http from 'node:http'
import net from 'node:net'
import { Bridge, allowedPeer, bridgeHosts, closingQuestion, parseTranscript, toolSummary, userText } from '../bin/coilshift-bridge.mjs'
import { VERSION, ensureBridge, local, older, socketPath } from '../lib/common.mjs'

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
    registryDir: path.join(dir, 'sessions'),
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
    { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/secret/plan.md' } }] } },
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
      ['tool', ''],
      ['user', 'Weiter'],
    ],
  )
  assert.equal(t.messages[2].count, 2, 'a run of tool calls is one entry')
  assert.equal(JSON.stringify(t).includes('secret'), false)
  assert.equal(JSON.stringify(t).includes('go test'), false, 'tool calls carry no details')
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
  assert.equal(s.delivery, 'fork', 'no relay: free text goes to a copy, the question stays in the terminal')
  await assert.rejects(b.reply({ session: 's1', prompt: s.pending.id, answers: { 'Q?': 'A' }, source: 'touch' }), (e) => e.status === 422)
  // Claude Code also asks for the question's dialog; it stays the question.
  const ask = { session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } }
  assert.deepEqual(await b.hook(ask, res), {})
  assert.equal(b.snapshot().sessions[0].pending.kind, 'question')
  assert.equal(b.snapshot().sessions[0].pending.questions[0].options[0].label, 'A')
  await b.hook({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {} }, res)
  assert.equal(b.snapshot().sessions[0].pending, undefined)
})

test('a question that was rejected or turned into a clarification does not stay open', async () => {
  const b = bridge()
  const res = { on() {} }
  const hook = (event, extra = {}) => b.hook({ session_id: 's1', hook_event_name: event, cwd: '/p', ...extra }, res)
  const ask = () => hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } })
  const pending = () => b.snapshot().sessions[0].pending
  await ask()
  assert.equal(pending().kind, 'question')
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
  assert.equal(pending(), undefined, 'the next tool call ends it')
  await ask()
  await hook('Stop', { last_assistant_message: 'Was möchtest du klären?' })
  assert.equal(pending().kind, 'input', 'the end of the turn ends it; a closing question may follow')
  await ask()
  await hook('UserPromptSubmit', { prompt: 'Darstellung kaputt' })
  assert.equal(pending(), undefined, 'a new prompt ends it')
})

test('tool calls count into one entry per run, without names or arguments', async () => {
  const b = bridge()
  const res = { on() {} }
  const hook = (event, extra = {}) => b.hook({ session_id: 's1', hook_event_name: event, cwd: '/p', ...extra }, res)
  await hook('UserPromptSubmit', { prompt: 'Teste alles' })
  for (const command of ['go test ./...', 'npm test', 'cat ~/.ssh/config']) await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command } })
  await hook('Stop', { last_assistant_message: 'Alle Tests laufen.' })
  await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/a.go' } })
  const messages = b.snapshot().sessions[0].messages
  assert.deepEqual(messages.map((m) => [m.role, m.count || 0]), [['user', 0], ['tool', 3], ['assistant', 0], ['tool', 1]])
  assert.equal(JSON.stringify(messages).includes('ssh'), false)
  assert.equal(new Set(messages.map((m) => m.id)).size, 4)
})

test('a plugin update replaces an older daemon, a newer one stays', async () => {
  assert.equal(older('0.1.0', '0.2.1'), true)
  assert.equal(older('0.2.1', '0.2.1'), false)
  assert.equal(older('0.10.0', '0.9.9'), false)
  assert.equal(older('0.2', '0.2.1'), true)
  const dir = tmp()
  const free = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
  const saved = { port: process.env.COILSHIFT_PORT, relay: process.env.COILSHIFT_RELAY }
  Object.assign(process.env, { COILSHIFT_PORT: String(free), COILSHIFT_RELAY: 'off' })
  // A daemon that says it is 9.0.0 stays; one that says 0.1.0 is stopped.
  let version = '9.0.0'
  let stopped = 0
  const fake = http.createServer((req, res) => {
    if (req.url === '/stop') {
      stopped++
      res.end('{"ok":true}')
      fake.close()
      fake.closeAllConnections()
      return
    }
    res.end(JSON.stringify({ ok: true, version }))
  })
  await new Promise((resolve) => fake.listen(socketPath(dir), resolve))
  try {
    assert.equal(await ensureBridge(dir), true)
    assert.equal(stopped, 0, 'a newer daemon stays')
    version = '0.1.0'
    assert.equal(await ensureBridge(dir, 8000), true)
    assert.equal(stopped, 1)
    const ping = await local(dir, 'GET', '/ping')
    assert.equal(ping.body.version, VERSION, 'the new daemon answers')
  } finally {
    await local(dir, 'POST', '/stop', {}).catch(() => {})
    if (saved.port === undefined) delete process.env.COILSHIFT_PORT
    else process.env.COILSHIFT_PORT = saved.port
    if (saved.relay === undefined) delete process.env.COILSHIFT_RELAY
    else process.env.COILSHIFT_RELAY = saved.relay
  }
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

test('the list order follows turns and questions, not tool calls or a restart', async () => {
  const b = bridge()
  const project = path.join(b.projectsDir, '-p')
  fs.mkdirSync(project)
  const idle = '11111111-1111-1111-1111-111111111111'
  fs.writeFileSync(path.join(project, idle + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'x' }, timestamp: new Date(1_700_000_000_000).toISOString() }) + '\n')
  fs.utimesSync(path.join(project, idle + '.jsonl'), 1_790_000_000, 1_790_000_000)
  b.agentsSource = async () => [
    { sessionId: idle, cwd: '/p', kind: 'interactive', status: 'idle', startedAt: 1_600_000_000_000 },
    { sessionId: 'notranscript', cwd: '/q', kind: 'interactive', status: 'idle', startedAt: 1_650_000_000_000 },
  ]
  await b.discover()
  assert.equal(b.sessions.get(idle).updated, 1_700_000_000_000, 'the last conversation entry, not the restart or the file time')
  assert.equal(b.sessions.get('notranscript').updated, 1_650_000_000_000, 'else its start')
  const res = { on() {} }
  const hook = (id, event, extra = {}) => b.hook({ session_id: id, hook_event_name: event, cwd: '/w', ...extra }, res)
  await hook('w1', 'UserPromptSubmit', { prompt: 'eins' })
  b.advance(1000)
  await hook('w2', 'UserPromptSubmit', { prompt: 'zwei' })
  const order = () => b.snapshot().sessions.map((s) => s.id)
  assert.deepEqual(order().slice(0, 2), ['w2', 'w1'])
  b.advance(1000)
  await hook('w1', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'make' } })
  await hook('w1', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'make' } })
  assert.deepEqual(order().slice(0, 2), ['w2', 'w1'], 'tool calls keep the places')
  b.advance(1000)
  await hook('w1', 'Stop', { last_assistant_message: 'Fertig.' })
  assert.deepEqual(order().slice(0, 2), ['w1', 'w2'], 'the end of a turn moves up')
})

test('sessions archived on another device leave the list; the registry gives activity and inbox socket', async () => {
  const b = bridge()
  const project = path.join(b.projectsDir, '-p')
  fs.mkdirSync(project)
  fs.mkdirSync(b.registryDir)
  const at = (iso) => ({ timestamp: iso })
  const write = (id, entries) => fs.writeFileSync(path.join(project, id + '.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const archived = '11111111-1111-1111-1111-111111111111'
  const revived = '22222222-2222-2222-2222-222222222222'
  const plain = '33333333-3333-3333-3333-333333333333'
  const gone = { type: 'system', subtype: 'informational', content: 'Remote Control disconnected — this session was ended or archived from another device or app (code 4090)' }
  write(archived, [{ type: 'user', message: { content: 'Hallo' }, ...at('2026-11-17T10:00:00Z') }, { ...gone, ...at('2026-11-18T08:09:43Z') }, { type: 'bridge-session', ...at('2026-11-18T08:09:44Z') }])
  write(revived, [{ ...gone, ...at('2026-11-18T08:00:00Z') }, { type: 'user', message: { content: 'Weiter' }, ...at('2026-11-18T08:30:00Z') }])
  write(plain, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Fertig.' }] }, ...at('2026-11-17T12:00:00Z') }, { type: 'pr-link', ...at('2026-11-18T08:00:00Z') }])
  fs.writeFileSync(path.join(b.registryDir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: plain, messagingSocketPath: '/tmp/cc-socks/4242.sock', statusUpdatedAt: Date.parse('2026-11-17T12:00:05Z') }))
  fs.writeFileSync(path.join(b.registryDir, 'junk.json'), '{')
  b.agentsSource = async () => [archived, revived, plain].map((sessionId) => ({ sessionId, cwd: '/p', kind: 'interactive', status: 'idle', startedAt: 1 }))
  b.relays.set('/tmp/cc-socks/4242.sock', { socket: null, results: new Map() })
  await b.discover()
  const shown = b.snapshot().sessions
  assert.deepEqual(shown.map((s) => s.id), [revived, plain], 'the archived session is hidden')
  assert.equal(shown[1].updated, Date.parse('2026-11-17T12:00:05Z'), 'activity from the registry, not the pr-link write')
  assert.equal(shown[1].delivery, 'inbox', 'the inbox socket from the registry matches the relay at once')
  await b.hook({ session_id: archived, hook_event_name: 'UserPromptSubmit', cwd: '/p', prompt: 'Noch eins' }, { on() {} })
  await b.discover()
  assert.equal(b.snapshot().sessions[0].id, archived, 'a new prompt brings it back')
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

test('replies: unknown session, a copy for a session without relay, resume with the project folder', async () => {
  const calls = []
  const b = bridge({ spawnClaude: async (args, cwd) => calls.push([args, cwd]) && 'abcdef12' })
  await assert.rejects(b.reply({ session: 'nope', text: 'x', source: 'touch' }), (e) => e.status === 404)
  await b.hook({ session_id: 's4', hook_event_name: 'SessionStart', cwd: '/p' }, { on() {} })
  await b.hook({ session_id: 's4', hook_event_name: 'UserPromptSubmit', prompt: 'Los' }, { on() {} })
  assert.equal(b.snapshot().sessions[0].delivery, 'fork')
  const copy = await b.reply({ session: 's4', text: 'Mach die Tests grün', source: 'touch' })
  assert.deepEqual([copy.delivered, copy.id], ['fork', 'abcdef12'])
  assert.deepEqual(calls[0], [['--bg', '--resume', 's4', '--fork-session', '[Aus dem Auto] Mach die Tests grün'], '/p'])
  assert.equal(b.sessions.get('s4').kind, 'interactive', 'the original keeps running in its terminal')
  await b.hook({ session_id: 's4', hook_event_name: 'SessionEnd', reason: 'other' }, { on() {} })
  assert.equal(b.snapshot().sessions[0].delivery, 'resume')
  const result = await b.reply({ session: 's4', text: 'Weiter', source: 'voice' })
  assert.equal(result.delivered, 'resume')
  assert.deepEqual(calls[1], [['--bg', '--resume', 's4', '[Aus dem Auto, per Sprache diktiert] Weiter'], '/p'])
  b.config.permission_mode = 'bypassPermissions'
  await b.start({ cwd: '/p', text: 'Neue Idee', source: 'touch' })
  assert.deepEqual(calls[2], [['--bg', '-n', 'Auto · Neue Idee', '--dangerously-skip-permissions', '[Aus dem Auto] Neue Idee'], '/p'])
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

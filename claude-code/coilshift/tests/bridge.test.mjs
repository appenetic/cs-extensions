import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import http from 'node:http'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Bridge, allowedPeer, bridgeHosts, closingQuestion, imageCount, noteEntry, parseTranscript, shrinkImage, speakText, speakable, taskNotifications, toolSummary, transcriptImages, userText, userTurn, voiceFor } from '../bin/coilshift-bridge.mjs'
import { VERSION, ensureBridge, local, macLang, older, socketPath } from '../lib/common.mjs'

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
    shrink: options.shrink,
    later: options.later,
    speak: options.speak,
    voice: options.voice,
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

// A turn as Claude Code writes it: steps with tool calls, a sub-agent started
// in the background, a background command, the agent's end as a notification,
// a prompt from the car and a summary of the conversation.
function richTranscript(file) {
  const at = (s) => `2026-11-26T08:00:${String(s).padStart(2, '0')}Z`
  const note = (fields) => '<task-notification>\n' + Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('\n') + '\n</task-notification>'
  const lines = [
    { type: 'user', uuid: 'c0', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: at(0), message: { role: 'user', content: 'This session is being continued from a previous conversation …' } },
    { type: 'user', uuid: 'u1', timestamp: at(1), message: { role: 'user', content: 'Sub-Agents zeigen' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'text', text: 'Ich prüfe die Formate.' }, { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 'r1', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'ok' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: at(4), message: { role: 'assistant', content: [{ type: 'text', text: 'Ich frage die Doku.' }, { type: 'tool_use', id: 'toolu_ag', name: 'Agent', input: { description: 'Hook-Felder prüfen', prompt: 'lange Anweisung', subagent_type: 'claude-code-guide', run_in_background: true } }] } },
    { type: 'user', uuid: 'r2', timestamp: at(5), toolUseResult: { isAsync: true, status: 'async_launched' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ag', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] } },
    { type: 'assistant', uuid: 'a3', timestamp: at(6), message: { role: 'assistant', content: [{ type: 'text', text: 'Der Agent läuft, ich warte.' }] } },
    { type: 'user', uuid: 'n1', timestamp: at(20), message: { role: 'user', content: note({ 'task-id': 'b1', 'tool-use-id': 'toolu_x', 'output-file': '/tmp/x', status: 'completed', summary: 'Background command "Wait for the feed" completed (exit code 0)' }) } },
    { type: 'user', uuid: 'n2', timestamp: at(30), message: { role: 'user', content: note({ 'task-id': 'a9', 'tool-use-id': 'toolu_ag', status: 'completed', summary: 'Agent "Hook-Felder prüfen" finished', note: 'A task-notification fires …', result: 'Die Felder heißen agent_id und agent_type.', usage: '…' }) + '\n<system-reminder>intern</system-reminder>' } },
    { type: 'assistant', uuid: 'a4', timestamp: at(31), message: { role: 'assistant', content: [{ type: 'text', text: 'Fertig: agent_id und agent_type.' }] } },
    { type: 'user', uuid: 'n3', timestamp: at(40), message: { role: 'user', content: note({ status: 'failed', summary: 'Background command "Build" failed with exit code 2' }) } },
    { type: 'user', uuid: 'u2', timestamp: at(50), message: { role: 'user', content: '[Aus dem Auto, per Sprache diktiert] Mach weiter' } },
  ]
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

test("the history shows Claude's steps, sub-agents, background work and summaries, never their XML", () => {
  const dir = tmp()
  const file = path.join(dir, 's.jsonl')
  richTranscript(file)
  const t = parseTranscript(file)
  const shown = t.messages.map((m) => [m.role, m.text, m.step || false, m.kind || '', m.state || ''])
  assert.deepEqual(shown, [
    ['event', '', false, 'compact', ''],
    ['user', 'Sub-Agents zeigen', false, '', ''],
    ['assistant', 'Ich prüfe die Formate.', true, '', ''],
    ['tool', '', false, '', ''],
    ['assistant', 'Ich frage die Doku.', true, '', ''],
    ['agent', 'Hook-Felder prüfen', false, '', 'done'],
    ['assistant', 'Der Agent läuft, ich warte.', false, '', ''],
    ['event', 'Wait for the feed', false, 'command', 'done'],
    ['assistant', 'Fertig: agent_id und agent_type.', false, '', ''],
    ['event', 'Build', false, 'command', 'failed'],
    ['car', 'Mach weiter', false, '', ''],
  ])
  const agent = t.messages.find((m) => m.role === 'agent')
  assert.equal(agent.agent, 'claude-code-guide')
  assert.equal(agent.result, 'Die Felder heißen agent_id und agent_type.')
  assert.equal(agent.ended - agent.at, 26000, 'from its start to its notification')
  assert.deepEqual(t.messages.filter((m) => m.kind === 'command').map((m) => m.exit), [0, 2])
  assert.equal(t.last, Date.parse('2026-11-26T08:00:50Z'))
  const json = JSON.stringify(t)
  for (const hidden of ['task-notification', 'lange Anweisung', 'intern', 'Aus dem Auto', 'This session is being continued']) assert.equal(json.includes(hidden), false, hidden)
})

test("a sub-agent's report back begins a turn: the answer before it stays an answer", () => {
  const dir = tmp()
  const file = path.join(dir, 's.jsonl')
  const at = (s) => `2026-11-26T09:00:${String(s).padStart(2, '0')}Z`
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'Prüf das' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Ich starte einen Agent.' }, { type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Prüfen', subagent_type: 'Explore' } }] } },
    { type: 'user', uuid: 'r1', timestamp: at(2), toolUseResult: { isAsync: true, status: 'async_launched' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Async agent launched successfully.' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Ich warte auf den Agent.' }] } },
    { type: 'user', uuid: 'n1', timestamp: at(20), message: { role: 'user', content: '<task-notification>\n<tool-use-id>toolu_a</tool-use-id>\n<status>completed</status>\n<summary>Agent "Prüfen" finished</summary>\n<result>Alles gut.</result>\n</task-notification>' } },
    { type: 'assistant', uuid: 'a3', timestamp: at(21), message: { role: 'assistant', content: [{ type: 'text', text: 'Der Agent sagt: alles gut.' }] } },
  ]
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  assert.deepEqual(parseTranscript(file).messages.map((m) => [m.role, m.text, m.step || false]), [
    ['user', 'Prüf das', false],
    ['assistant', 'Ich starte einen Agent.', true],
    ['agent', 'Prüfen', false],
    ['assistant', 'Ich warte auf den Agent.', false],
    ['assistant', 'Der Agent sagt: alles gut.', false],
  ])
})

test('notifications of background work become events or complete their agent', () => {
  const n = taskNotifications('<task-notification>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Monitor event: "deploy"</summary>\n</task-notification>')
  assert.deepEqual(noteEntry(n[0]), { event: { kind: 'notice', state: '', text: 'Monitor event: "deploy"' } })
  assert.deepEqual(noteEntry({ toolUseId: 't', status: 'failed', summary: 'Agent "Review" failed: Agent terminated early due to an API error', result: '' }),
    { agent: { tool: 't', name: 'Review', state: 'failed', result: 'Agent terminated early due to an API error' } })
  assert.equal(noteEntry({ toolUseId: 't', status: 'completed', summary: 'Agent "Review" is waiting on its own background work', result: '' }).agent.state, 'running')
  assert.deepEqual(noteEntry({ toolUseId: '', status: 'completed', summary: 'Background command "Build" completed (exit code 1)', result: '' }).event,
    { kind: 'command', state: 'failed', text: 'Build', exit: 1 }, 'a non-zero exit is a failure')
  assert.deepEqual(userTurn('[From the car] go on'), { role: 'car', text: 'go on' })
  assert.deepEqual(userTurn('<task-notification><summary>Goal check-in: still running</summary></task-notification>').notes.map((x) => x.summary), ['Goal check-in: still running'])
})

test("a hooked session follows its transcript: every step, the car's prompt once, its answers kept", async () => {
  const b = bridge()
  const res = { on() {} }
  const file = path.join(b.projectsDir, 'live.jsonl')
  const hook = (event, extra = {}) => b.hook({ session_id: 'live', hook_event_name: event, cwd: '/p', transcript_path: file, ...extra }, res)
  const write = (lines) => fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const at = (s) => new Date(b.now() + s * 1000).toISOString()
  const prompt = { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'Baue es' } }
  const step = { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Ich baue jetzt.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }] } }
  // The prompt shows at once, before the transcript has it, and only once after.
  await hook('UserPromptSubmit', { prompt: 'Baue es' })
  assert.deepEqual(b.snapshot().sessions[0].messages.map((m) => [m.role, m.text]), [['user', 'Baue es']])
  write([prompt, step])
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'make' } })
  assert.deepEqual(b.snapshot().sessions[0].messages.map((m) => [m.role, m.text, m.step || false]),
    [['user', 'Baue es', false], ['assistant', 'Ich baue jetzt.', true], ['tool', '', false]], 'the step before the tool call shows')
  // A background command ends: its notification comes as a prompt and shows as an event.
  const notification = '<task-notification>\n<status>completed</status>\n<summary>Background command "make" completed (exit code 0)</summary>\n</task-notification>'
  await hook('UserPromptSubmit', { prompt: notification })
  assert.equal(JSON.stringify(b.snapshot()).includes('task-notification'), false)
  // The answer from Stop, already in the transcript, shows once.
  const answer = { type: 'assistant', uuid: 'a2', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Gebaut.' }] } }
  write([prompt, step, answer])
  await hook('Stop', { last_assistant_message: 'Gebaut.' })
  let messages = b.snapshot().sessions[0].messages
  assert.deepEqual(messages.filter((m) => m.role === 'assistant').map((m) => [m.text, m.step || false]), [['Ich baue jetzt.', true], ['Gebaut.', false]])
  // From the car: a prompt through the inbox and an answer to a permission.
  const s = b.sessions.get('live')
  b.addMessage(s, 'car', 'Teste auch')
  b.addMessage(s, 'car', 'Freigegeben: Bash', { keep: true })
  const inbox = 'Another Claude session sent a message:\n[Aus dem Auto] Teste auch'
  await hook('UserPromptSubmit', { prompt: inbox })
  assert.equal(JSON.stringify(b.snapshot()).includes('Another Claude'), false)
  write([prompt, step, answer, { type: 'user', uuid: 'u2', isMeta: true, timestamp: at(9), message: { role: 'user', content: inbox } }])
  b.sync(s)
  messages = b.snapshot().sessions[0].messages
  assert.deepEqual(messages.filter((m) => m.role === 'car').map((m) => m.text), ['Freigegeben: Bash', 'Teste auch'])
  assert.equal(messages.find((m) => m.text === 'Teste auch').id, 'u2', "the transcript's copy of the car's prompt")
  assert.equal(messages.filter((m) => m.role === 'car' && m.text === 'Teste auch').length, 1, "the car's prompt shows once")
  assert.equal(messages.filter((m) => m.text === 'Freigegeben: Bash').length, 1, 'its answer stays')
  assert.equal(messages.some((m) => 'keep' in m), false, 'the bridge keeps its marks to itself')
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

test('a restarted bridge answers the car at once: its revisions start at the clock', async () => {
  const before = bridge()
  for (let i = 0; i < 50; i++) before.touch()
  const after = bridge()
  after.advance(1000)
  const restarted = new Bridge(after.dir, { name: 'Testmac', projectsDir: after.projectsDir, registryDir: after.registryDir, now: after.now, agents: async () => [] })
  assert.ok(restarted.rev > before.snapshot().rev, 'ahead of the revision the car knows')
  const started = Date.now()
  await restarted.waitRev(before.snapshot().rev, 25000)
  assert.ok(Date.now() - started < 1000, 'no wait for the long poll to run out')
})

// A 1×1 PNG, as Claude Code keeps a pasted image in the transcript.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const pasted = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

test('pasted images: counted on the message, found in the transcript, made small once', async () => {
  assert.equal(imageCount('[Image #1] schau [Image #12]'), 2)
  assert.equal(imageCount('[Image #1][Image #2][Image #3][Image #4][Image #5]'), 4, 'at most four')
  assert.equal(imageCount('kein Bild'), 0)
  const shrunk = []
  const b = bridge({ shrink: async (image) => (shrunk.push(image.data), { type: 'image/jpeg', data: 'a2xlaW4=' }) })
  const file = path.join(b.projectsDir, 's2.jsonl')
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-18T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '[Image #1] Schau' }, pasted('AAAA')] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-11-18T10:00:05Z', message: { role: 'user', content: [{ type: 'tool_result', content: [pasted('TOOL')] }] } },
    { type: 'user', uuid: 'u3', timestamp: '2026-11-18T10:01:00Z', message: { role: 'user', content: [{ type: 'text', text: '[Image #2] [Image #3] zwei' }, pasted('BBBB'), pasted('CCCC')] } },
  ]
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  assert.deepEqual(parseTranscript(file).messages.map((m) => [m.id, m.images]), [['u1', 1], ['u3', 2]], 'images of tool results are not pasted ones')
  assert.deepEqual((await transcriptImages(file, { id: 'u1' })).map((i) => i.data), ['AAAA'])
  assert.deepEqual((await transcriptImages(file, { id: 'm9', text: '[Image #2] [Image #3] zwei', at: 0 })).map((i) => i.data), ['BBBB', 'CCCC'])
  assert.deepEqual((await transcriptImages(file, { id: 'm9', text: 'anders', at: Date.parse('2026-11-18T10:00:50Z') })).map((i) => i.data), ['BBBB', 'CCCC'], 'else the closest in time')
  assert.equal((await transcriptImages(file, { id: 'm9', text: 'anders', at: Date.parse('2026-11-18T10:05:00Z') })).length, 0, 'but not further than a minute')

  const res = { on() {} }
  // From the hooks: only the prompt, with a mark for each image; the
  // transcript's entry with the same words takes its place.
  await b.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/p', transcript_path: file, prompt: '[Image #2] [Image #3] zwei' }, res)
  // At the start: the transcript's entries with their ids.
  await b.hook({ session_id: 's2', hook_event_name: 'SessionStart', cwd: '/p', transcript_path: file }, res)
  const snap = b.snapshot()
  const hooked = snap.sessions.find((s) => s.id === 's1').messages.find((m) => m.text === '[Image #2] [Image #3] zwei')
  assert.deepEqual([hooked.id, hooked.images], ['u3', 2])
  assert.equal(snap.sessions.find((s) => s.id === 's1').messages.length, 2, 'the hooks\' copy is gone')
  assert.deepEqual(snap.sessions.find((s) => s.id === 's2').messages.map((m) => m.images), [1, 2])
  const device = b.redeem(b.newCode(), 'Tesla')
  const get = (q) => b.handle({ method: 'GET', url: new URL('https://bridge/v1/image?' + new URLSearchParams(q)), authorization: 'Bearer ' + device, body: {} })
  assert.deepEqual(await get({ session: 's1', message: hooked.id, n: 1 }), { status: 200, body: { type: 'image/jpeg', data: 'a2xlaW4=' } })
  await get({ session: 's1', message: hooked.id, n: 1 })
  assert.deepEqual(shrunk, ['CCCC'], 'made small once')
  assert.equal((await get({ session: 's2', message: 'u1', n: 0 })).status, 200)
  assert.deepEqual(shrunk, ['CCCC', 'AAAA'])
  for (const q of [{ session: 's1', message: hooked.id, n: 2 }, { session: 's1', message: 'nope', n: 0 }, { session: 'x', message: 'u1', n: 0 }, { session: 's2', message: 'u1', n: 'a' }]) {
    assert.equal((await get(q)).status, 404, JSON.stringify(q))
  }
  assert.equal((await b.handle({ method: 'GET', url: new URL('https://bridge/v1/image?session=s2&message=u1&n=0'), authorization: 'Bearer nope', body: {} })).status, 401)

  // Without sips a small original goes as it is.
  const plain = bridge({ shrink: async () => { throw new Error('no sips') } })
  const plainFile = path.join(plain.projectsDir, 's3.jsonl')
  fs.writeFileSync(plainFile, JSON.stringify(lines[0]) + '\n')
  await plain.hook({ session_id: 's3', hook_event_name: 'SessionStart', cwd: '/p', transcript_path: plainFile }, res)
  const token = plain.redeem(plain.newCode(), 'Tesla')
  const out = await plain.handle({ method: 'GET', url: new URL('https://bridge/v1/image?session=s3&message=u1&n=0'), authorization: 'Bearer ' + token, body: {} })
  assert.deepEqual(out, { status: 200, body: { type: 'image/png', data: 'AAAA' } })
})

test('sips makes an image a JPEG of at most 1024 pixels a side and never larger', { skip: process.platform !== 'darwin' }, async () => {
  const dir = tmp()
  const size = (data) => {
    const file = path.join(dir, 'check.jpg')
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return [...execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' }).matchAll(/: *(\d+)/g)].map((m) => Number(m[1]))
  }
  const small = await shrinkImage({ type: 'image/png', data: PIXEL }, dir)
  assert.equal(small.type, 'image/jpeg')
  assert.deepEqual(size(small.data), [1, 1], 'not blown up')
  const big = path.join(dir, 'big.png')
  fs.writeFileSync(path.join(dir, 'pixel.png'), Buffer.from(PIXEL, 'base64'))
  execFileSync('sips', ['-z', '1500', '2400', path.join(dir, 'pixel.png'), '--out', big], { stdio: 'ignore' })
  const made = await shrinkImage({ type: 'image/png', data: fs.readFileSync(big).toString('base64') }, dir)
  assert.deepEqual(size(made.data), [1024, 640])
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('image-')), [], 'no work files left')
})

test("Claude's answers read aloud: Markdown made speakable, speech made once, only for answers", async () => {
  const markdown = [
    '**Fertig:** `alpha.20` steht → im [Feed](https://example.com/x).',
    '- eins',
    '- zwei!',
    '',
    '| a | b |',
    '|---|---|',
    '```',
    'go test ./...',
    '```',
    'Mehr unter https://example.com/doku',
  ].join('\n')
  assert.equal(speakable(markdown), 'Fertig: alpha.20 steht, im Feed.\neins.\nzwei!\nTabelle ausgelassen.\nCodeblock ausgelassen.\nMehr unter Link.')
  const spoken = []
  let broken = false
  const b = bridge({
    speak: async (text, voice) => {
      spoken.push([text, voice])
      if (broken) throw new Error('say failed')
      return { type: 'audio/mp4', data: 'dG9u' }
    },
    voice: async () => 'Anna',
  })
  const res = { on() {} }
  await b.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/p', prompt: 'Wie weit?' }, res)
  await b.hook({ session_id: 's1', hook_event_name: 'Stop', cwd: '/p', last_assistant_message: '**Fertig.** Alles grün.' }, res)
  const [question, answer] = b.snapshot().sessions[0].messages
  const device = b.redeem(b.newCode(), 'Tesla')
  const get = (q) => b.handle({ method: 'GET', url: new URL('https://bridge/v1/speech?' + new URLSearchParams(q)), authorization: 'Bearer ' + device, body: {} })
  assert.deepEqual(await get({ session: 's1', message: answer.id }), { status: 200, body: { type: 'audio/mp4', data: 'dG9u' } })
  await get({ session: 's1', message: answer.id })
  assert.deepEqual(spoken, [['Fertig. Alles grün.', 'Anna']], 'made once, in German')
  assert.equal((await get({ session: 's1', message: question.id })).status, 404, "only Claude's answers")
  assert.equal((await get({ session: 's1', message: 'nope' })).status, 404)
  // The configured voice wins; a failing say is a German message and is tried again.
  b.config.voice = 'Petra'
  broken = true
  await b.hook({ session_id: 's1', hook_event_name: 'Stop', cwd: '/p', last_assistant_message: 'Noch eins.' }, res)
  const next = b.snapshot().sessions[0].messages.at(-1)
  const failed = await get({ session: 's1', message: next.id })
  assert.deepEqual([failed.status, failed.body.message], [422, 'Der Mac kann gerade nicht vorlesen.'])
  broken = false
  assert.equal((await get({ session: 's1', message: next.id })).status, 200)
  assert.deepEqual(spoken.slice(1), [['Noch eins.', 'Petra'], ['Noch eins.', 'Petra']])
})

test('say speaks German as AAC and leaves no work files', { skip: process.platform !== 'darwin' }, async () => {
  const dir = tmp()
  const voice = await voiceFor('de')
  assert.equal(typeof voice, 'string')
  // English never gets the first voice listed, a novelty voice such as Albert.
  assert.ok(['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', ''].includes(await voiceFor('en')))
  const out = await speakText('Hallo aus dem Auto.', voice, dir)
  assert.equal(out.type, 'audio/mp4')
  assert.ok(out.data.length > 1000 && Buffer.from(out.data, 'base64').subarray(4, 8).toString() === 'ftyp', 'an MP4 file')
  assert.deepEqual(fs.readdirSync(dir), [])
})

test("the bridge's words for the car follow the language its long poll names, German before it names one", async () => {
  const calls = []
  const spoken = []
  const b = bridge({
    spawnClaude: async (args) => {
      calls.push(args)
      return 'abcdef12'
    },
    speak: async (text, voice) => {
      spoken.push([text, voice])
      return { type: 'audio/mp4', data: 'dG9u' }
    },
    voice: async (lang) => (lang === 'en' ? 'Samantha' : 'Anna'),
  })
  const res = { on() {} }
  const device = b.redeem(b.newCode(), 'Tesla')
  const call = (method, route, body = {}) => b.handle({ method, url: new URL('https://bridge' + route), authorization: 'Bearer ' + device, body })
  const state = (q) => call('GET', '/v1/state?' + new URLSearchParams({ since: '0', wait: '0', ...q }))
  const pending = (id) => {
    const shown = b.snapshot().sessions
    const s = shown.find((x) => x.id === id)
    assert.ok(s, `${id} is not among ${shown.map((x) => x.id)}`)
    return s.pending
  }
  const permission = (id) => b.hook({ session_id: id, hook_event_name: 'PermissionRequest', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'ls' } }, res)
  await permission('g')
  assert.deepEqual([pending('g').title, pending('g').text], ['Freigabe', 'Claude möchte Bash ausführen.'], 'German before a car names a language')
  // An older car names none, and only de and en count.
  await state({})
  await state({ lang: 'fr' })
  assert.equal(b.carLang, 'de')
  // A new language is a new revision at once, so the long poll does not wait.
  const rev = b.rev
  const answer = await state({ lang: 'en', since: String(rev), wait: '30' })
  assert.equal(answer.status, 200)
  assert.ok(answer.body.rev > rev)
  assert.equal(b.carLang, 'en')
  await permission('e')
  assert.deepEqual([pending('e').title, pending('e').text], ['Approval', 'Claude wants to run Bash.'])
  await b.hook({ session_id: 'q', hook_event_name: 'PreToolUse', cwd: '/p', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which one?', options: [] }] } }, res)
  assert.equal(pending('q').title, 'Claude asks')
  await b.hook({ session_id: 'w', hook_event_name: 'Stop', cwd: '/p', last_assistant_message: 'Shall I go on?' }, res)
  assert.equal(pending('w').title, 'Claude is waiting for you')
  await b.hook({ session_id: 'n', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, res)
  assert.equal(b.snapshot().sessions.find((s) => s.id === 'n').title, 'Session', 'a session without a name or folder')
  // Errors the car shows.
  assert.deepEqual(await call('POST', '/v1/reply', { session: 'nope', text: 'x' }), { status: 404, body: { error: 'failed', message: 'The Mac no longer knows this session.' } })
  const open = await call('POST', '/v1/reply', { session: 'e', prompt: pending('e').id, decision: 'allow' })
  assert.equal(open.body.message, 'The question is open in the terminal. With away mode on, future questions can be answered in the car.')
  assert.equal((await call('POST', '/v1/hide', { session: 'nope' })).body.message, 'The Mac no longer knows this session.')
  // What the driver sends is marked for Claude in the car's language.
  assert.equal((await b.reply({ session: 'w', text: 'Yes', source: 'touch' })).delivered, 'fork')
  await b.reply({ session: 'w', text: 'Go on', source: 'voice' })
  assert.deepEqual(calls.map((args) => args.at(-1)), ['[From the car] Yes', '[From the car, dictated by voice] Go on'])
  // A held permission denied in the car, as Claude and the history get it.
  b.config.away = 'on'
  const held = b.hook({ session_id: 'h', hook_event_name: 'PermissionRequest', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }, res)
  await b.reply({ session: 'h', prompt: pending('h').id, decision: 'deny', source: 'card' })
  assert.deepEqual(await held, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied in the car.' } } })
  assert.equal(b.snapshot().sessions.find((s) => s.id === 'h').messages.at(-1).text, 'Denied: Bash')
  b.config.away = 'auto'
  // Read aloud with an English voice, code and tables named in English.
  assert.equal(speakable('Done.\n```\nx\n```\n| a | b |', 'en'), 'Done.\nCode block skipped.\nTable skipped.')
  await b.hook({ session_id: 'r', hook_event_name: 'Stop', cwd: '/p', last_assistant_message: 'Done.\n```\nnpm test\n```' }, res)
  const said = b.snapshot().sessions.find((s) => s.id === 'r').messages.at(-1)
  assert.equal((await call('GET', '/v1/speech?' + new URLSearchParams({ session: 'r', message: said.id }))).status, 200)
  assert.deepEqual(spoken, [['Done.\nCode block skipped.', 'Samantha']])
  // Back to German.
  await state({ lang: 'de' })
  await permission('d')
  assert.equal(pending('d').title, 'Freigabe')
})

test("what the commands print follows the Mac's locale: German for German, English for any other", () => {
  assert.equal(macLang({ LANG: 'de_DE.UTF-8' }), 'de')
  assert.equal(macLang({ LANG: 'de_AT' }), 'de')
  assert.equal(macLang({ LANG: 'de' }), 'de')
  assert.equal(macLang({ LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(macLang({ LANG: 'fr_FR.UTF-8' }), 'en')
  assert.equal(macLang({ LANG: 'C' }), 'en')
  assert.equal(macLang({ LANG: 'dev' }), 'en')
  assert.equal(macLang({ LC_ALL: 'en_GB.UTF-8', LANG: 'de_DE.UTF-8' }), 'en', 'LC_ALL first')
  assert.equal(macLang({ LC_MESSAGES: 'de_CH.UTF-8', LANG: 'en_US.UTF-8' }), 'de', 'then LC_MESSAGES')
  assert.ok(['de', 'en'].includes(macLang({})), 'without any, the locale of Intl')
  // The status command against a data directory without a bridge.
  const dir = tmp()
  const script = fileURLToPath(new URL('../bin/coilshift-bridge.mjs', import.meta.url))
  const run = (lang) => execFileSync(process.execPath, [script, 'status', '--data', dir], { env: { ...process.env, LC_ALL: '', LC_MESSAGES: '', LANG: lang }, encoding: 'utf8' }).trim()
  assert.equal(run('de_DE.UTF-8'), 'Die Bridge läuft nicht. Sie startet mit der nächsten Claude-Code-Sitzung.')
  assert.equal(run('en_US.UTF-8'), 'The bridge is not running. It starts with the next Claude Code session.')
})

test('sessions without a word stay out of the car, like the half-hourly probes of CodexBar', async () => {
  const timers = []
  const b = bridge({ later: (fn, ms) => timers.push({ fn, ms }) })
  const res = { on() {} }
  const probe = '/Users/s/Library/Application Support/CodexBar/ClaudeProbe'
  const hook = (id, event, extra = {}) => b.hook({ session_id: id, hook_event_name: event, cwd: probe, ...extra }, res)
  const ids = () => b.snapshot().sessions.map((s) => s.id)
  await b.hook({ session_id: 'real', hook_event_name: 'UserPromptSubmit', cwd: '/p', prompt: 'Baue die Kachel' }, res)
  // One with a fixed id waits half a minute without a word ...
  await hook('fixed', 'SessionStart', { source: 'startup' })
  assert.deepEqual(ids(), ['real'])
  b.advance(25000)
  await hook('fixed', 'SessionEnd')
  // ... then a new one only runs "/usage".
  await hook('usage', 'SessionStart', { source: 'startup' })
  await hook('usage', 'UserPromptSubmit', { prompt: '/usage' })
  assert.deepEqual(ids(), ['real'])
  await hook('usage', 'SessionEnd')
  const snap = b.snapshot()
  assert.deepEqual([snap.sessions.map((s) => s.id), snap.projects.map((p) => p.cwd), snap.hidden], [['real'], ['/p'], 0], 'not in the list, not offered as a project')
  assert.deepEqual([...b.sessions.keys()], ['real'], 'nothing kept of them')
  // A new terminal session without a word joins after a minute.
  await b.hook({ session_id: 'fresh', hook_event_name: 'SessionStart', cwd: '/q', source: 'startup' }, res)
  assert.deepEqual(ids(), ['real'])
  b.advance(60000)
  const rev = b.snapshot().rev
  assert.equal(timers.at(-1).ms, 60000)
  timers.at(-1).fn()
  assert.ok(b.snapshot().rev > rev, 'a new revision tells the car')
  assert.deepEqual(ids(), ['fresh', 'real'])
  // A plugin command with an answer is a conversation, and so is a prompt
  // that starts with a path.
  await b.hook({ session_id: 'pair', hook_event_name: 'UserPromptSubmit', cwd: '/h', prompt: '/coilshift:pair' }, res)
  await b.hook({ session_id: 'pair', hook_event_name: 'Stop', cwd: '/h', last_assistant_message: 'Kopplungslink' }, res)
  await b.hook({ session_id: 'pair', hook_event_name: 'SessionEnd', cwd: '/h' }, res)
  await b.hook({ session_id: 'path', hook_event_name: 'UserPromptSubmit', cwd: '/h', prompt: '/Users/s/plan.md lesen' }, res)
  assert.deepEqual(ids().sort(), ['fresh', 'pair', 'path', 'real'])
})

test('a session hidden in the car stays hidden until it is active again', async () => {
  const b = bridge()
  const res = { on() {} }
  const hook = (id, event, extra = {}) => b.hook({ session_id: id, hook_event_name: event, cwd: '/p', ...extra }, res)
  await hook('a', 'UserPromptSubmit', { prompt: 'eins' })
  await hook('b', 'UserPromptSubmit', { prompt: 'zwei' })
  const device = b.redeem(b.newCode(), 'Tesla')
  const call = (path, body) => b.handle({ method: 'POST', url: new URL('https://bridge' + path), authorization: 'Bearer ' + device, body })
  b.advance(1000)
  assert.equal((await call('/v1/hide', { session: 'a' })).status, 200)
  assert.equal((await call('/v1/hide', { session: 'nope' })).status, 404)
  let snap = b.snapshot()
  assert.deepEqual([snap.sessions.map((s) => s.id), snap.hidden], [['b'], 1])
  assert.ok(JSON.parse(fs.readFileSync(path.join(b.dir, 'config.json'), 'utf8')).hidden.a, 'kept across restarts')
  await hook('a', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
  assert.deepEqual(b.snapshot().sessions.map((s) => s.id), ['b'], 'a tool call is not enough to come back')
  b.advance(1000)
  await hook('a', 'Stop', { last_assistant_message: 'Fertig.' })
  snap = b.snapshot()
  assert.deepEqual([snap.sessions.map((s) => s.id), snap.hidden], [['a', 'b'], 0], 'the end of a turn brings it back')
  await call('/v1/hide', { session: 'b' })
  await call('/v1/unhide', {})
  assert.equal(b.snapshot().sessions.length, 2)
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

test("a sub-agent's tool calls neither close an open question nor count as the session's", async () => {
  const b = bridge()
  const res = { on() {} }
  const hook = (event, extra = {}) => b.hook({ session_id: 's1', hook_event_name: event, cwd: '/p', ...extra }, res)
  await hook('UserPromptSubmit', { prompt: 'Frag mich' })
  await hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Welche Farbe?', header: 'Farbe', options: [{ label: 'Rot' }] }] } })
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'a1', agent_type: 'Explore' })
  const s = b.snapshot().sessions[0]
  assert.equal(s.pending && s.pending.kind, 'question', 'the question stays open')
  assert.equal(s.messages.some((m) => m.role === 'tool'), false)
  await hook('PostToolUse', { tool_name: 'AskUserQuestion' })
  assert.equal(b.snapshot().sessions[0].pending, undefined, "the session's own next step settles it")
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

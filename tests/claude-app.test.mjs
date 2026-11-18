import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHost } from './vendor/panel-host.mjs';

// The app is the launcher tile: no panel, no bridge; the host is only the DOM.
const pkg = 'packages/claude/';
const manifest = JSON.parse(fs.readFileSync(pkg + 'coilshift.json'));
const question = { id: 'p1', kind: 'question', title: 'Claude fragt', text: 'Welche Farbe?', since: 5,
  questions: [{ question: 'Welche Farbe?', header: 'Farbe', multiSelect: false, options: [{ label: 'Rot' }, { label: 'Blau', description: 'kühl' }] }] };
// A fetch that finds no service: the page shows its starting state.
function host_fetch_refuse(h) {
  h.window.fetch = () => Promise.reject(new Error('connection refused'));
}
function view(overrides = {}) {
  return {
    schema: 1, rev: 7, now: 1800000000, theme: 'night', gear: 'P',
    link: { state: 'online', bridge: 'Testmac', since: 1 },
    pairing: { state: 'closed' }, diag: { 'web.listen': 'ok', card: 'ok', voice: 'bereit · GUI_carAssistUserTranscript' },
    bridge: { name: 'Testmac', version: '0.1.0', away: true },
    projects: [{ cwd: '/Users/s/Developer/CS_Plugins', title: 'CS_Plugins' }],
    sessions: [
      { id: 's1', title: 'CS_Plugins', cwd: '/Users/s/Developer/CS_Plugins', kind: 'interactive', status: 'waiting', updated: 1799999990000,
        delivery: 'hook', pending: question, messages: [{ id: 'm1', role: 'user', text: 'Baue die Kachel', at: 1799999900000 }, { id: 'm2', role: 'assistant', text: '<b>kein HTML</b>', at: 1799999950000 }] },
      { id: 's2', title: 'lb-connect', cwd: '/Users/s/lb', kind: 'background', status: 'working', updated: 1799999000000, delivery: 'inbox', messages: [] },
    ],
    ...overrides,
  };
}
// The tile's own web service, recording every call.
function fakeFetch(state, calls) {
  return (url, init = {}) => {
    const call = { url, method: init.method || 'GET', auth: init.headers && init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url === '/api/bootstrap') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ token: 't0k' }) });
    const body = url.includes('/api/view') ? state.view : state.answer || { ok: true, delivered: 'hook' };
    return Promise.resolve({ ok: !state.fail, status: state.fail ? 409 : 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
  };
}
async function setup({ fetchState, calls = [] } = {}) {
  const host = createHost({});
  host.window.fetch = fakeFetch(fetchState, calls);
  host.load([pkg + 'web/app.js']);
  await host.settle(25);
  return host;
}
const el = (h, id) => h.document.getElementById(id);
const root = (h) => el(h, 'root');
// Runs the long-poll loop's pending timeouts once.
async function poll(h) {
  for (const timer of h.timers.filter((t) => t.live && !t.interval)) {
    timer.live = false;
    timer.fn();
  }
  await h.settle(25);
}

test('manifest: a launcher tile on the web port, no CoilShift tab, no vehicle writes', () => {
  assert.equal(manifest.tile.url, 'web:app');
  assert.equal(manifest.tile.icon, 'web/icon.png');
  assert.deepEqual(manifest.web, [{ name: 'app', service: 'web' }]);
  assert.equal(manifest.panel, undefined);
  assert.ok(!manifest.capabilities.includes('panel'));
  assert.ok(!manifest.capabilities.some((c) => c.startsWith('dv.write')));
});

test('before the service answers the tile says so and keeps the fields closed', async () => {
  const h = createHost({});
  host_fetch_refuse(h);
  h.load([pkg + 'web/app.js']);
  await h.settle(25);
  assert.match(el(h, 'link-state').textContent, /startet/);
  assert.equal(el(h, 'away').disabled, true);
});

test('a session can be hidden in the car and all of them shown again', async () => {
  const calls = [];
  const h = await setup({ fetchState: { view: view({ hidden: 2 }), answer: { ok: true } }, calls });
  assert.equal(el(h, 'unhide').textContent, '2 ausgeblendet · wieder einblenden');
  el(h, 'hide').click();
  await h.settle(25);
  assert.deepEqual(calls.find((c) => c.url.endsWith('/api/hide')).body, { session: 's1' });
  assert.match(el(h, 'flash').textContent, /Ausgeblendet/);
  el(h, 'unhide').click();
  await h.settle(25);
  assert.ok(calls.some((c) => c.url.endsWith('/api/unhide')));
});

test('answers of a question stand one per row', async () => {
  const h = await setup({ fetchState: { view: view() }, calls: [] });
  const rows = el(h, 'prompt').findAll((e) => e.className === 'options stack');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].children.map((b) => b.getAttribute('aria-label')), ['Rot', 'Blau']);
});

test('the tile answers a held question with one tap', async () => {
  const calls = [];
  const state = { view: view() };
  const h = await setup({ fetchState: state, calls });
  assert.equal(calls[0].url, '/api/bootstrap');
  assert.match(el(h, 'link-state').textContent, /Verbunden · Testmac/);
  assert.match(el(h, 'messages').textContent, /<b>kein HTML<\/b>/, 'shown as text');
  root(h).byLabel('Blau').click();
  await h.settle(25);
  const reply = calls.find((c) => c.url.endsWith('/api/reply'));
  assert.equal(reply.url, '/api/reply');
  assert.equal(reply.auth, 'Bearer t0k');
  assert.deepEqual(reply.body, { session: 's1', prompt: 'p1', source: 'touch', answers: { 'Welche Farbe?': 'Blau' } });
  assert.match(el(h, 'flash').textContent, /Antwort gesendet · an die wartende Frage/);
});

test('typing survives updates, and free text goes into the running session', async () => {
  const calls = [];
  const state = { view: view() };
  const h = await setup({ fetchState: state, calls });
  root(h).byLabel('lb-connect').click();
  await h.settle();
  const composer = el(h, 'composer');
  assert.equal(composer.disabled, false);
  composer.type('Bitte die Tests ausführen');
  state.view = view({ rev: 8 });
  await poll(h);
  assert.equal(el(h, 'composer'), composer, 'the same textarea, so the keyboard stays open');
  assert.equal(composer.value, 'Bitte die Tests ausführen');
  assert.match(el(h, 'composer-hint').textContent, /laufende Sitzung/);
  state.answer = { ok: true, delivered: 'inbox' };
  el(h, 'send').click();
  await h.settle(25);
  const reply = calls.filter((c) => c.url.endsWith('/api/reply')).at(-1);
  assert.deepEqual(reply.body, { session: 's2', prompt: '', source: 'touch', text: 'Bitte die Tests ausführen' });
  assert.equal(composer.value, '');
  assert.match(el(h, 'flash').textContent, /in die laufende Sitzung/);
});

test('a refused answer is shown and keeps the text', async () => {
  const calls = [];
  const state = { view: view({ sessions: [{ ...view().sessions[1], id: 's3', title: 'alt', kind: 'ended', status: 'ended', delivery: 'resume' }] }) };
  const h = await setup({ fetchState: state, calls });
  assert.equal(el(h, 'send').textContent, 'Fortsetzen');
  el(h, 'composer').type('Weiter');
  state.fail = true;
  state.answer = { error: 'bridge', message: 'Der Projektordner existiert auf dem Mac nicht mehr: /x' };
  el(h, 'send').click();
  await h.settle(25);
  assert.match(el(h, 'flash').textContent, /Projektordner/);
  assert.equal(el(h, 'composer').value, 'Weiter');
});

test('a session without inbox relay still takes text, as a copy in the background', async () => {
  const calls = [];
  const old = { id: 'old', title: 'Alte Sitzung', cwd: '/p', kind: 'interactive', status: 'working', updated: 1799999990000, delivery: 'fork', messages: [] };
  const h = await setup({ fetchState: { view: view({ sessions: [old] }), answer: { ok: true, delivered: 'fork', id: 'abcdef12' } }, calls });
  assert.equal(el(h, 'composer').disabled, false, 'the field stays open, also while driving');
  assert.equal(el(h, 'send').textContent, 'Als Kopie senden');
  assert.match(el(h, 'composer-hint').textContent, /Kopie im Hintergrund/);
  el(h, 'composer').type('Mach die Tests grün');
  el(h, 'send').click();
  await h.settle(25);
  assert.deepEqual(calls.find((c) => c.url.endsWith('/api/reply')).body, { session: 'old', prompt: '', source: 'touch', text: 'Mach die Tests grün' });
  assert.match(el(h, 'flash').textContent, /als Kopie im Hintergrund/);
});

test("Claude's Markdown is drawn: tables, lists, emphasis, code; HTML stays text", async () => {
  const text = [
    '**Vorher-Messung** mit `alpha.11`:',
    '',
    '| Zeit | Zustand |',
    '|---|:---:|',
    '| 0–44 s | „online“ |',
    '| 107 s | Relay über **EMQX** |',
    '',
    '- Warm',
    '  - parallel',
    '- 4 s Timeout',
    '',
    '1. eins',
    '2. zwei',
    '',
    '```',
    'go test ./...',
    '```',
    '<b>kein HTML</b> und a | b ohne Tabelle',
  ].join('\n');
  const s = { id: 'md', title: 'Markdown', cwd: '/p', kind: 'interactive', status: 'idle', updated: 1799999990000, delivery: 'inbox',
    messages: [{ id: 'm1', role: 'assistant', text, at: 1799999950000 }] };
  const h = await setup({ fetchState: { view: view({ sessions: [s] }) }, calls: [] });
  const box = el(h, 'messages').find((e) => e.className === 'text md');
  const all = (tag) => box.findAll((e) => e.tagName === tag.toUpperCase());
  assert.deepEqual(all('th').map((e) => e.textContent), ['Zeit', 'Zustand']);
  assert.deepEqual(all('td').map((e) => e.textContent), ['0–44 s', '„online“', '107 s', 'Relay über EMQX']);
  assert.deepEqual(all('strong').map((e) => e.textContent), ['Vorher-Messung', 'EMQX']);
  assert.deepEqual(all('li').map((e) => e.textContent), ['Warmparallel', 'parallel', '4 s Timeout', 'eins', 'zwei']);
  assert.equal(all('pre')[0].textContent, 'go test ./...');
  assert.equal(all('code')[0].textContent, 'alpha.11');
  assert.doesNotMatch(box.textContent, /\*\*|\|---|```/, 'no Markdown syntax left');
  assert.match(box.textContent, /<b>kein HTML<\/b> und a \| b ohne Tabelle/, 'HTML and a lone pipe stay text');
  assert.equal(all('b').length, 0);
});

test('sessions with an open question lead the list', async () => {
  const plain = (id, updated) => ({ id, title: id, cwd: '/p', kind: 'interactive', status: 'idle', updated, delivery: 'inbox', messages: [] });
  const asking = { ...plain('asks', 1799990000000), status: 'waiting', delivery: 'hook', pending: question };
  const h = await setup({ fetchState: { view: view({ sessions: [plain('newest', 1799999990000), asking, plain('older', 1799980000000)] }) }, calls: [] });
  assert.deepEqual(el(h, 'sessions').findAll((e) => e.className.startsWith('session')).map((e) => e.getAttribute('aria-label')), ['asks', 'newest', 'older']);
});

test('unpaired: the QR code of the pairing page and no session list', async () => {
  const calls = [];
  const state = { view: view({ link: { state: 'unpaired', since: 1 }, sessions: [], bridge: undefined,
    pairing: { state: 'open', expires: 1800000600, addresses: [
      { url: 'https://100.70.1.2:41234/#abc', qr: 'data:image/png;base64,QQ==' },
      { url: 'https://192.168.1.50:41234/#abc', qr: 'data:image/png;base64,Qg==' }] } }) };
  const h = await setup({ fetchState: state, calls });
  assert.equal(el(h, 'pairing-qr').getAttribute('src'), 'data:image/png;base64,QQ==');
  assert.match(el(h, 'setup-steps').textContent, /claude plugin marketplace add appenetic\/cs-extensions/);
  assert.match(el(h, 'setup-steps').textContent, /claude plugin install coilshift@appenetic/);
  assert.match(el(h, 'setup-steps').textContent, /\/coilshift:pair/);
  assert.match(el(h, 'pairing-url').textContent, /^https:\/\/100\.70\.1\.2:41234\//);
  assert.doesNotMatch(el(h, 'pairing-url').textContent, /abc/, 'the one-time code is not printed');
  assert.equal(el(h, 'split').getAttribute('hidden'), '');
  root(h).byText('192.168.1.50').click();
  await h.settle();
  assert.equal(el(h, 'pairing-qr').getAttribute('src'), 'data:image/png;base64,Qg==');
});

test('unpaired: the relay code works without a shared network, the QR code stays as the phone way', async () => {
  const state = { view: view({ link: { state: 'unpaired', since: 1 }, sessions: [], bridge: undefined,
    pairing: { state: 'open', expires: 1800000600, code: 'K7QM-4ZP2-XR9T-HB3D', message: 'Kopplung mit Mac läuft …', addresses: [
      { url: 'https://192.168.1.50:41234/#abc', qr: 'data:image/png;base64,Qg==' }] } }) };
  const h = await setup({ fetchState: state, calls: [] });
  assert.equal(el(h, 'pairing-code').textContent, '/coilshift:pair K7QM-4ZP2-XR9T-HB3D');
  assert.match(el(h, 'setup-steps').textContent, /claude plugin install coilshift@appenetic/);
  assert.match(el(h, 'setup-steps').textContent, /ohne Tailscale/);
  assert.equal(el(h, 'pairing-message').textContent, 'Kopplung mit Mac läuft …');
  assert.equal(el(h, 'pairing-qr').getAttribute('src'), 'data:image/png;base64,Qg==');
  assert.match(root(h).byText('Oder mit dem Handy, im selben WLAN oder Tailnet wie das Auto').textContent, /Handy/);
});

test('the technical view names the route to the Mac', async () => {
  const h = await setup({ fetchState: { view: view({ diag: { route: 'relay broker.emqx.io:8883' } }) }, calls: [] });
  assert.match(el(h, 'diag').textContent, /Internet-Relay · broker\.emqx\.io:8883/);
});

test('tool calls show as small bubbles of dots that move only while Claude works on them', async () => {
  const messages = [
    { id: 'm1', role: 'user', text: 'Teste alles', at: 1799999900000 },
    { id: 'm2', role: 'tool', text: '', count: 3, at: 1799999910000 },
    { id: 'm3', role: 'tool', text: 'Bash: rm -rf build', at: 1799999911000 },
    { id: 'm4', role: 'assistant', text: 'Zwei Tests sind rot.', at: 1799999920000 },
    { id: 'm5', role: 'tool', text: '', count: 1, at: 1799999930000 }];
  const working = { id: 's9', title: 'Tests', cwd: '/p', kind: 'interactive', status: 'working', updated: 1799999990000, delivery: 'inbox', messages };
  const h = await setup({ fetchState: { view: view({ sessions: [working] }) }, calls: [] });
  const items = [...el(h, 'messages').children];
  assert.deepEqual(items.map((li) => li.getAttribute('class')), ['message tool', 'message assistant', 'message tool', 'message user']);
  const typing = (node) => node.find((e) => e.className.startsWith('typing'));
  const [latest, , earlier] = items.map((li) => typing(li));
  assert.equal(latest.getAttribute('class'), 'typing live');
  assert.equal(latest.children.length, 3);
  assert.equal(earlier.getAttribute('class'), 'typing', 'an earlier run stays still');
  assert.equal(earlier.getAttribute('aria-label'), '4 Werkzeugaufrufe');
  assert.doesNotMatch(el(h, 'messages').textContent, /rm -rf|Werkzeug/, 'no tool details in the car');
  const idle = await setup({ fetchState: { view: view({ sessions: [{ ...working, status: 'idle' }] }) }, calls: [] });
  assert.equal(typing(el(idle, 'messages')).getAttribute('class'), 'typing', 'still when Claude is done');
});

test('a new background session starts in a known project', async () => {
  const calls = [];
  const state = { view: view(), answer: { ok: true, id: 'abcdef12' } };
  const h = await setup({ fetchState: state, calls });
  el(h, 'new-session').click();
  await h.settle();
  assert.equal(el(h, 'new').getAttribute('hidden'), null);
  el(h, 'task').type('Lies die README und fasse sie zusammen');
  el(h, 'start').click();
  await h.settle(25);
  const start = calls.find((c) => c.url.endsWith('/api/start'));
  assert.deepEqual(start.body, { cwd: '/Users/s/Developer/CS_Plugins', text: 'Lies die README und fasse sie zusammen', source: 'touch' });
  assert.match(el(h, 'flash').textContent, /Neue Sitzung gestartet/);
});

test('narrow screens: an open question opens its session, back shows the list', async () => {
  const calls = [];
  const state = { view: view() };
  const h = await setup({ fetchState: state, calls });
  assert.equal(el(h, 'split').getAttribute('class'), 'split show-detail');
  el(h, 'back').click();
  await h.settle();
  assert.equal(el(h, 'split').getAttribute('class'), 'split');
  root(h).byLabel('lb-connect').click();
  await h.settle();
  assert.equal(el(h, 'split').getAttribute('class'), 'split show-detail');
  const texts = el(h, 'messages').children.map((li) => li.textContent);
  assert.equal(texts.length, 1);
  state.view = view({ rev: 9 });
  state.view.sessions[0].messages.push({ id: 'm3', role: 'assistant', text: 'Neueste Antwort', at: 1799999990000 });
  root(h).byLabel('CS_Plugins').click();
  await poll(h);
  assert.match(el(h, 'messages').children[0].textContent, /Neueste Antwort/, 'newest first');
});

test('a working session gets a small pulsing green dot, in step across updates', async () => {
  const calls = [];
  const state = { view: view() };
  const h = await setup({ fetchState: state, calls });
  const dots = (label) => root(h).byLabel(label).findAll((e) => e.getAttribute('class') === 'pulse');
  assert.equal(dots('lb-connect').length, 1, 'working');
  assert.equal(dots('CS_Plugins').length, 0, 'an open question shows the orange dot instead');
  assert.match(dots('lb-connect')[0].style.animationDelay, /^-\d+ms$/);
  assert.equal(dots('lb-connect')[0].getAttribute('aria-label'), 'arbeitet gerade');
  state.view = view({ rev: 8, sessions: view().sessions.map((x) => ({ ...x, status: 'idle' })) });
  await poll(h);
  assert.equal(dots('lb-connect').length, 0, 'gone once the session is idle');
});

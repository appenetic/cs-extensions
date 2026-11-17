import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHost } from './vendor/panel-host.mjs';

const pkg = 'packages/claude/';
const manifest = JSON.parse(fs.readFileSync(pkg + 'coilshift.json'));
const question = { id: 'p1', kind: 'question', title: 'Claude fragt', text: 'Welche Farbe?', since: 5,
  questions: [{ question: 'Welche Farbe?', header: 'Farbe', multiSelect: false, options: [{ label: 'Rot' }, { label: 'Blau', description: 'kühl' }] }] };
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
// A fetch for the panel's direct path to the web port, recording every call.
function fakeFetch(state, calls) {
  return (url, init = {}) => {
    const call = { url, method: init.method || 'GET', auth: init.headers && init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const body = url.includes('/api/view') ? state.view : state.answer || { ok: true, delivered: 'hook' };
    return Promise.resolve({ ok: !state.fail, status: state.fail ? 409 : 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
  };
}
async function setup({ data = {}, fetchState, calls = [] } = {}) {
  const host = createHost({ permissions: manifest.panel.permissions, data });
  if (fetchState) host.window.fetch = fakeFetch(fetchState, calls);
  host.load([pkg + 'panel/csdk-panel.js', pkg + 'panel/app.js']);
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

test('manifest: tile, web port, read-only panel and no vehicle writes', () => {
  assert.equal(manifest.tile.url, 'web:app');
  assert.deepEqual(manifest.web, [{ name: 'app', service: 'web' }]);
  assert.deepEqual(manifest.panel.permissions, ['status', 'data']);
  assert.ok(!manifest.capabilities.some((c) => c.startsWith('dv.write')));
  assert.match(manifest.panel.entry, /^panel\/claude-.+\.html$/);
});

test('without a reachable web port the panel mirrors state.json read-only', async () => {
  const h = await setup({ data: { 'state.json': JSON.stringify(view()) } });
  assert.match(el(h, 'readonly').textContent, /Nur-Lese-Ansicht/);
  assert.match(el(h, 'sessions').textContent, /CS_Plugins/);
  assert.match(el(h, 'sessions').textContent, /Frage offen/);
  const blau = root(h).byLabel('Blau');
  assert.equal(blau.disabled, true);
  assert.equal(el(h, 'composer').disabled, true);
  assert.equal(el(h, 'away').disabled, true);
  assert.equal(h.requests('data.get').some((r) => r.params.name === 'endpoint.json'), true);
  assert.match(el(h, 'messages').textContent, /<b>kein HTML<\/b>/, 'shown as text');
});

test('live panel answers a held question with one tap', async () => {
  const calls = [];
  const state = { view: view() };
  const h = await setup({ data: { 'endpoint.json': JSON.stringify({ port: 29701, token: 't0k' }) }, fetchState: state, calls });
  assert.equal(el(h, 'readonly'), null);
  assert.match(el(h, 'link-state').textContent, /Verbunden · Testmac/);
  root(h).byLabel('Blau').click();
  await h.settle(25);
  const reply = calls.find((c) => c.url.endsWith('/api/reply'));
  assert.equal(reply.url, 'http://127.0.0.1:29701/api/reply');
  assert.equal(reply.auth, 'Bearer t0k');
  assert.deepEqual(reply.body, { session: 's1', prompt: 'p1', source: 'touch', answers: { 'Welche Farbe?': 'Blau' } });
  assert.match(el(h, 'flash').textContent, /Antwort gesendet · an die wartende Frage/);
});

test('typing survives updates, and free text goes into the running session', async () => {
  const calls = [];
  const state = { view: view() };
  const h = await setup({ data: { 'endpoint.json': JSON.stringify({ port: 29701, token: 't0k' }) }, fetchState: state, calls });
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
  const h = await setup({ data: { 'endpoint.json': JSON.stringify({ port: 29701, token: 't0k' }) }, fetchState: state, calls });
  assert.equal(el(h, 'send').textContent, 'Fortsetzen');
  el(h, 'composer').type('Weiter');
  state.fail = true;
  state.answer = { error: 'bridge', message: 'Der Projektordner existiert auf dem Mac nicht mehr: /x' };
  el(h, 'send').click();
  await h.settle(25);
  assert.match(el(h, 'flash').textContent, /Projektordner/);
  assert.equal(el(h, 'composer').value, 'Weiter');
});

test('unpaired: the QR code of the pairing page and no session list', async () => {
  const calls = [];
  const state = { view: view({ link: { state: 'unpaired', since: 1 }, sessions: [], bridge: undefined,
    pairing: { state: 'open', expires: 1800000600, addresses: [
      { url: 'https://100.70.1.2:41234/#abc', qr: 'data:image/png;base64,QQ==' },
      { url: 'https://192.168.1.50:41234/#abc', qr: 'data:image/png;base64,Qg==' }] } }) };
  const h = await setup({ data: { 'endpoint.json': JSON.stringify({ port: 29701, token: 't0k' }) }, fetchState: state, calls });
  assert.equal(el(h, 'pairing-qr').getAttribute('src'), 'data:image/png;base64,QQ==');
  assert.match(el(h, 'pairing-url').textContent, /^https:\/\/100\.70\.1\.2:41234\//);
  assert.doesNotMatch(el(h, 'pairing-url').textContent, /abc/, 'the one-time code is not printed');
  assert.equal(el(h, 'split').getAttribute('hidden'), '');
  root(h).byText('192.168.1.50').click();
  await h.settle();
  assert.equal(el(h, 'pairing-qr').getAttribute('src'), 'data:image/png;base64,Qg==');
});

test('a new background session starts in a known project', async () => {
  const calls = [];
  const state = { view: view(), answer: { ok: true, id: 'abcdef12' } };
  const h = await setup({ data: { 'endpoint.json': JSON.stringify({ port: 29701, token: 't0k' }) }, fetchState: state, calls });
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
  const h = await setup({ data: { 'endpoint.json': JSON.stringify({ port: 29701, token: 't0k' }) }, fetchState: state, calls });
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
  const h = await setup({ data: { 'endpoint.json': JSON.stringify({ port: 29701, token: 't0k' }) }, fetchState: state, calls });
  const dots = (label) => root(h).byLabel(label).findAll((e) => e.getAttribute('class') === 'pulse');
  assert.equal(dots('lb-connect').length, 1, 'working');
  assert.equal(dots('CS_Plugins').length, 0, 'an open question shows the orange dot instead');
  assert.match(dots('lb-connect')[0].style.animationDelay, /^-\d+ms$/);
  assert.equal(dots('lb-connect')[0].getAttribute('aria-label'), 'arbeitet gerade');
  state.view = view({ rev: 8, sessions: view().sessions.map((x) => ({ ...x, status: 'idle' })) });
  await poll(h);
  assert.equal(dots('lb-connect').length, 0, 'gone once the session is idle');
});

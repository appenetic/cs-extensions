import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHost } from './vendor/panel-host.mjs';
const pkg = 'packages/home-assistant/';
const manifest = JSON.parse(fs.readFileSync(pkg + 'coilshift.json'));
async function setup(options = {}) {
  const settings = manifest.settings.map(s => ({...s, id: manifest.id + '.' + s.id,
    value: s.default === undefined ? '' : s.default, ...(s.type === 'secret' ? {secret:true} : {})}));
  settings.find(s => s.id.endsWith('.url')).value = 'https://ha.example';
  if (options.enabled) settings.find(s => s.id.endsWith('.enabled')).value = 'true';
  const host = createHost({ permissions: manifest.panel.permissions, settings,
    status: {state:'degraded',reason:'Home Assistant bridge disabled.'}, ...options });
  host.load([pkg + 'panel/csdk-panel.js', pkg + 'panel/app.js']);
  await host.settle(25);
  return host;
}
const field = (h,id) => h.document.getElementById(id);
const save = h => h.document.getElementById('root').byLabel('Einstellungen speichern').click();
const changes = h => h.requests('settings.set').map(r => [r.params.id.split('.').at(-1),r.params.value]);
test('panel declared, loads every setting, does not expose or rewrite secrets', async () => {
  const h=await setup();
  assert.ok(manifest.capabilities.includes('panel'));
  assert.equal(field(h,'password').value,'');
  assert.match(field(h,'password').getAttribute('placeholder'),/Gespeichert/);
  for(const setting of manifest.settings) assert.equal(field(h,setting.id).disabled,false);
  assert.deepEqual(changes(h),[]);
  assert.match(field(h,'package-status').textContent,/disabled/);
});
test('normal save preserves secrets and only writes changed field',async()=>{
  const h=await setup();field(h,'interval').type('15');save(h);await h.settle(50);
  assert.deepEqual(changes(h),[['interval','15'],['enabled','false']]);
  assert.match(field(h,'message').textContent,/Gespeichert/);
});
test('password replacement and explicit token deletion',async()=>{
  const h=await setup();field(h,'password').type('new "secret"');
  h.document.getElementById('root').byLabel('API-Token löschen').click();save(h);await h.settle(50);
  assert.ok(changes(h).some(([id,v])=>id==='password'&&v==='new "secret"'));
  assert.ok(changes(h).some(([id,v])=>id==='access_token'&&v===''));
  assert.equal(field(h,'password').value,'');
  assert.doesNotMatch(field(h,'root').textContent,/new "secret"/);
});
test('firmware profile sets mph; enabled connection updates disable first and enable last',async()=>{
  const h=await setup({enabled:true});
  field(h,'root').byLabel('Firmware-Profil übernehmen').click();save(h);await h.settle(70);
  const writes=changes(h);
  assert.deepEqual(writes[0],['enabled','false']);assert.deepEqual(writes.at(-1),['enabled','true']);
  assert.ok(writes.some(([id,v])=>id==='speed_unit'&&v==='mph'));
  assert.ok(writes.some(([id,v])=>id==='door_dv'&&v==='VAPI_driverDoor'));
});
test('invalid URL or interval never writes; status polling preserves edits',async()=>{
  const h=await setup();field(h,'url').type('http://bad');save(h);await h.settle();assert.deepEqual(changes(h),[]);
  field(h,'url').type('https://ha.example');field(h,'interval').type('1');save(h);await h.settle();assert.deepEqual(changes(h),[]);
  field(h,'username').type('unsaved');await h.tick();assert.equal(field(h,'username').value,'unsaved');
});
test('failed partial save does not re-enable or show server error secrets',async()=>{
  let h;
  h=await setup({enabled:true,answers:{'settings.set':({id,value})=>{
    if(id.endsWith('.url'))throw new Error('credential-in-error');
    h.settings.find(s=>s.id===id).value=value;return {ok:true};
  }}});
  field(h,'url').type('https://new.example');save(h);await h.settle(70);
  assert.deepEqual(changes(h),[['enabled','false'],['url','https://new.example']]);
  assert.match(field(h,'message').textContent,/fehlgeschlagen/);
  assert.doesNotMatch(field(h,'root').textContent,/credential-in-error/);
  assert.equal(field(h,'enabled').checked,false);
});
test('missing settings keep saving disabled with useful feedback',async()=>{
  const h=await setup({settings:[]});
  assert.equal(field(h,'root').byLabel('Einstellungen speichern').disabled,true);
  assert.match(field(h,'message').textContent,/fehlend:/);
  save(h);await h.settle();assert.deepEqual(changes(h),[]);
});

test('late settings registration recovers automatically and enables fields',async()=>{
 let ready=false,h;
 h=await setup({answers:{'settings.get':()=>ready ? h.settings.map(s=>({...s,value:s.type==='secret'?{set:true}:s.value})) : []}});
 assert.equal(field(h,'url').disabled,true);
 assert.match(field(h,'settings-connection').textContent,/liefert 0/);
 ready=true;await h.tick();
 assert.equal(field(h,'url').disabled,false);
 assert.match(field(h,'settings-connection').textContent,/Einstellungen verbunden/);
});
test('host refusal is explained at top of page and not bypassed',async()=>{
 const h=await setup({answers:{'settings.get':()=>{throw Object.assign(new Error('denied'),{code:'forbidden'});}}});
 assert.match(field(h,'settings-connection').textContent,/verweigert/);
 assert.match(field(h,'settings-connection').textContent,/forbidden/);
 assert.equal(field(h,'url').disabled,true);
 save(h);await h.settle();assert.deepEqual(changes(h),[]);
});
test('explicit host availability restrictions remain enforced',async()=>{
 const h=await setup({settings:manifest.settings.map(s=>({...s,id:manifest.id+'.'+s.id,value:s.default??'',available:false}))});
 assert.match(field(h,'settings-connection').textContent,/gesperrt/);
 assert.equal(field(h,'url').disabled,true);
 assert.equal(field(h,'root').byLabel('Einstellungen speichern').disabled,true);
});

test('explicit panel scope exposes all thirteen settings on a scope-only host',async()=>{
 const expected=manifest.settings.map(s=>manifest.id+'.'+s.id).sort();
 assert.equal(expected.length,13);
 assert.deepEqual([...manifest.panel.settings].sort(),expected);
 let h;
 const allowed=new Set(manifest.panel.settings);
 h=await setup({answers:{'settings.get':()=>{
  // A host which does not automatically add the package settings only returns
  // settings explicitly named in panel.settings. The old manifest returned [].
  return {settings:manifest.settings.filter(s=>allowed.has(manifest.id+'.'+s.id)).map(s=>({
   ...s,id:manifest.id+'.'+s.id,value:s.type==='secret'?{set:true}:s.default
  }))};
 }}});
 assert.equal(field(h,'url').disabled,false);
 assert.equal(field(h,'root').byLabel('Einstellungen speichern').disabled,false);
 field(h,'url').type('https://ha.example');field(h,'username').type('test-user');save(h);await h.settle(50);
 assert.ok(changes(h).some(([id,value])=>id==='username'&&value==='test-user'));
 assert.match(field(h,'message').textContent,/Gespeichert/);
});

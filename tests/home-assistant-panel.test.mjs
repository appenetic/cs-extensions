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
  host.load([pkg + 'panel/csdk-panel.js', pkg + 'panel/settings-schema.js', pkg + 'panel/app.js']);
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
  assert.match(field(h,'message').textContent,/nicht vollständig bestätigen/);
  assert.doesNotMatch(field(h,'root').textContent,/credential-in-error/);
  assert.equal(h.settings.find(s=>s.id.endsWith('.enabled')).value,'false');
  assert.equal(field(h,'enabled').checked,true); // keep the intended draft for retry
});
test('empty settings reply leaves URL and profile editable; writes still use host',async()=>{
 const h=await setup({answers:{'settings.get':()=>[]}});
 assert.equal(field(h,'root').byLabel('Einstellungen speichern').disabled,false);
 assert.equal(field(h,'url').disabled,false);
 field(h,'url').type('https://my-ha.example');
 field(h,'root').byLabel('Firmware-Profil übernehmen').click();
 assert.equal(field(h,'latitude_dv').value,'NAV_vehicleLatitude');
 assert.equal(field(h,'speed_unit').value,'mph');
 save(h);await h.settle(70);
 assert.ok(changes(h).some(([id,v])=>id==='url'&&v==='https://my-ha.example'));
 assert.ok(changes(h).some(([id,v])=>id==='latitude_dv'&&v==='NAV_vehicleLatitude'));
 assert.ok(!changes(h).some(([id])=>id==='password'||id==='access_token'));
 assert.match(field(h,'message').textContent,/Schreibvorgänge bestätigt/);
 assert.match(field(h,'message').textContent,/noch nicht geprüft/);
});
test('late settings registration recovers automatically and enables fields',async()=>{
 let ready=false,h;
 h=await setup({answers:{'settings.get':()=>ready ? h.settings.map(s=>({...s,value:s.type==='secret'?{set:true}:s.value})) : []}});
 assert.equal(field(h,'url').disabled,false);
 field(h,'url').type('https://unsaved.example');
 assert.match(field(h,'settings-connection').textContent,/liefert 0/);
 ready=true;await h.tick();
 assert.equal(field(h,'url').value,'https://unsaved.example');
 assert.equal(field(h,'url').disabled,false);
 assert.match(field(h,'settings-connection').textContent,/Einstellungen verbunden/);
});
test('host refusal is explained at top of page and not bypassed',async()=>{
 const h=await setup({answers:{'settings.get':()=>{throw Object.assign(new Error('denied'),{code:'forbidden'});}}});
 assert.match(field(h,'settings-connection').textContent,/verweigert/);
 assert.match(field(h,'settings-connection').textContent,/forbidden/);
 assert.equal(field(h,'url').disabled,false);
 assert.equal(field(h,'root').byLabel('Einstellungen speichern').disabled,true);
 save(h);await h.settle();assert.deepEqual(changes(h),[]);
});
test('explicit host availability restrictions remain enforced',async()=>{
 const h=await setup({settings:manifest.settings.map(s=>({...s,id:manifest.id+'.'+s.id,value:s.default??'',available:false}))});
 assert.match(field(h,'settings-connection').textContent,/sperrt:/);
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

test('empty read plus rejected write never reports a successful save or discards draft',async()=>{
 const h=await setup({answers:{'settings.get':()=>[], 'settings.set':()=>{throw Object.assign(new Error('private value'),{code:'not_found'});}}});
 field(h,'url').type('https://draft.example');field(h,'password').type('keep-this');save(h);await h.settle(50);
 assert.match(field(h,'message').textContent,/nicht vollständig bestätigen/);
 assert.match(field(h,'message').textContent,/not_found/);
 assert.doesNotMatch(field(h,'root').textContent,/private value/);
 assert.equal(field(h,'url').value,'https://draft.example');
 assert.equal(field(h,'password').value,'keep-this');
 assert.equal(field(h,'url').disabled,false);
});

test('vehicle defaults are prefilled and advanced controls start collapsed',async()=>{
 const h=await setup();
 assert.equal(field(h,'latitude_dv').value,'NAV_vehicleLatitude');
 assert.equal(field(h,'longitude_dv').value,'NAV_vehicleLongitude');
 assert.equal(field(h,'speed_dv').value,'NAV_vehicleSpeedMph');
 assert.equal(field(h,'speed_unit').value,'mph');
 assert.equal(field(h,'door_dv').value,'VAPI_driverDoor');
 assert.equal(field(h,'advanced-settings').getAttribute('open'),null);
 // A saved custom value still wins over the new manifest default.
 const settings=manifest.settings.map(s=>({...s,id:manifest.id+'.'+s.id,value:s.id==='latitude_dv'?'CUSTOM_lat':s.default}));
 const custom=await setup({settings});
 assert.equal(field(custom,'latitude_dv').value,'CUSTOM_lat');
});
test('phone transfer fills a draft without auto-saving; polling does not replay it',async()=>{
 const transfer={schema:1,id:'pairing-1',expires:Date.now()/1000+120,values:{url:'https://phone.example',username:'from-phone',password:'phone-secret'}};
 const h=await setup({data:{'phone-input.json':JSON.stringify(transfer),'phone-setup.json':JSON.stringify({schema:1,state:'sent'})}});
 assert.equal(field(h,'url').value,'https://phone.example');
 assert.equal(field(h,'password').value,'phone-secret');
 assert.deepEqual(changes(h),[]);
 field(h,'url').type('https://edited.example');await h.tick();
 assert.equal(field(h,'url').value,'https://edited.example');
 save(h);await h.settle(70);
 assert.ok(changes(h).some(([id,v])=>id==='password'&&v==='phone-secret'));
 assert.equal(field(h,'password').value,'');
});
test('expired phone input cannot replace fields',async()=>{
 const h=await setup({data:{'phone-input.json':JSON.stringify({schema:1,id:'old',expires:1,values:{url:'https://old.example'}})}});
 assert.equal(field(h,'url').value,'https://ha.example');
});

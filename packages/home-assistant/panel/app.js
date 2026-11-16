(function () {
  'use strict';
  var bridge = window.csdkPanel.createClient(window);
  var root = document.getElementById('root');
  var fields = {}, records = {}, cleared = {}, busy = false, settingsReady = false, loadingSettings = false, dirty = {}, writeBlocked = false, pluginMode = false;
  var phoneInputID = "", phoneLinks = [], profileButton = null;
  var schema = window.haSettingsSchema;
  var declarations = {};
  schema.settings.forEach(function (setting) { declarations[setting.id] = setting; });
  var groups = [
    ['Verbindung', [
      ['enabled', 'Home Assistant aktivieren', 'bool'],
      ['url', 'Home-Assistant-URL', 'url', 'HTTPS-Basis-URL, z. B. https://deine-instanz.ui.nabu.casa'],
      ['username', 'Benutzername', 'text'],
      ['password', 'Passwort', 'secret', 'Leer lassen, um das gespeicherte Passwort beizubehalten.'],
      ['access_token', 'API-Token', 'secret', 'Optional. Hat Vorrang vor Benutzername und Passwort; bei MFA verwenden.']]],
    ['Übertragung', [
      ['entity_prefix', 'Entitätsname', 'text'],
      ['interval', 'Aktualisierungsintervall (Sekunden)', 'number', '5 bis 300 Sekunden. Standard: 10.']]],
    ['Fahrzeugdaten', [
      ['latitude_dv', 'DataValue Breitengrad', 'text'],
      ['longitude_dv', 'DataValue Längengrad', 'text'],
      ['speed_dv', 'DataValue Geschwindigkeit', 'text'],
      ['speed_unit', 'Einheit des Quellwerts', 'enum'],
      ['door_dv', 'DataValue Fahrertür', 'text'],
      ['soc_dv', 'DataValue Akkuladestand', 'text']]]
  ];
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    for (var i = 2; i < arguments.length; i++) el.append(arguments[i]);
    return el;
  }
  var message = h('p', { 'aria-live': 'polite', id: 'message' });
  var connection = h('p', { class: 'notice', 'aria-live': 'polite', id: 'settings-connection' }, 'Verbindung zu den CoilShift-Einstellungen wird aufgebaut …');
  var state = h('div', { class: 'notice', 'aria-live': 'polite', id: 'package-status' }, 'Status wird geladen …');
  var saveButton = h('button', { type: 'button', class: 'primary', 'aria-label': 'Einstellungen speichern' }, 'Einstellungen speichern');
  saveButton.disabled = true;
  function say(text, tone) { message.textContent = text; message.setAttribute('class', tone || ''); }
  var phoneNote = h('p', {id:'phone-note', 'aria-live':'polite'}, 'Handy-Eingabe wird gesucht …');
  var phoneQR = h('img', {id:'phone-qr', alt:'QR-Code für die Handy-Eingabe', width:'256', height:'256'});
  var phoneAddresses = h('div', {class:'actions', id:'phone-addresses'});
  var phoneCard = h('section', {class:'card', id:'phone-setup'}, h('h2',{},'Am Handy einrichten'),
    h('p',{},'Handy und Auto ins gleiche WLAN bringen oder über Tailscale verbinden. QR-Code scannen, URL und Zugangsdaten am Handy eingeben und auf die MCU übernehmen.'),
    phoneNote, phoneQR, phoneAddresses,
    h('p',{class:'hint'},'Die Verbindung verwendet ein lokales HTTPS-Zertifikat, das am Handy einmal bestätigt werden muss. Der Link gilt fünf Minuten und nur einmal. Danach die übernommenen Werte hier prüfen und speichern.'));
  function build() {
    root.replaceChildren(h('h1', {}, 'Home Assistant'), h('p', { class: 'subtitle' }, 'Verbindung und Fahrzeugdaten konfigurieren. UI ' + schema.version), phoneCard, connection, state);
    var advanced = h('details', { class: 'card', id: 'advanced-settings' }, h('summary', {}, 'Erweitert · Übertragung und Fahrzeugdaten'));
    groups.forEach(function (group) {
      var card = h('section', { class: 'card' }, h('h2', {}, group[0]));
      group[1].forEach(function (spec) {
        var id = spec[0], type = spec[2];
        var input = h(type === 'enum' ? 'select' : 'input', { id: id, 'aria-label': spec[1] });
        input.disabled = false;
        records[id] = {id: schema.package + '.' + id, value: declarations[id].default, unconfirmed: true};
        if (type === 'bool') input.checked = declarations[id].default === true;
        else input.value = type === 'secret' ? '' : String(declarations[id].default == null ? '' : declarations[id].default);
        input.addEventListener('input', function () { dirty[id] = true; });
        input.addEventListener('change', function () { dirty[id] = true; });
        if (type !== 'enum') input.setAttribute('type', type === 'bool' ? 'checkbox' : type === 'secret' ? 'password' : type);
        if (type === 'secret') input.setAttribute('autocomplete', 'new-password');
        if (type === 'number') { input.setAttribute('min', '5'); input.setAttribute('max', '300'); input.setAttribute('step', '1'); }
        var control = input;
        if (type === 'enum') [['kph','km/h'],['mps','m/s'],['mph','mph']].forEach(function (choice) { input.append(h('option', { value: choice[0] }, choice[1])); });
        if (type === 'secret') {
          var clear = h('button', { type: 'button', 'aria-label': spec[1] + ' löschen' }, 'Löschen');
          clear.disabled = false;
          clear.addEventListener('click', function () { cleared[id] = true; dirty[id] = true; input.value = ''; input.setAttribute('placeholder', 'Wird beim Speichern gelöscht'); });
          input.addEventListener('input', function () { cleared[id] = false; });
          control = h('div', { class: 'secret-actions' }, input, clear);
          fields[id] = { input: input, type: type, clear: clear };
        } else fields[id] = { input: input, type: type };
        var row = h('div', { class: 'field' }, h('label', { for: id }, spec[1]), control);
        if (spec[3]) row.append(h('p', { class: 'hint' }, spec[3]));
        card.append(row);
      });
      if (group[0] === 'Fahrzeugdaten') {
        var profile = h('button', { type: 'button', 'aria-label': 'Firmware-Profil übernehmen' }, 'Firmware-Profil übernehmen');
        profileButton = profile;
        profile.addEventListener('click', function () {
          if (busy) return;
          var values = { latitude_dv: 'NAV_vehicleLatitude', longitude_dv: 'NAV_vehicleLongitude', speed_dv: 'NAV_vehicleSpeedMph', speed_unit: 'mph', door_dv: 'VAPI_driverDoor', soc_dv: 'VAPI_batteryLevel' };
          Object.keys(values).forEach(function (id) { if (!fields[id].input.disabled) { fields[id].input.value = values[id]; dirty[id] = true; } });
          say('Firmware-Profil eingetragen. Zum Übernehmen speichern.');
        });
        root.append(h('div', { class: 'notice' }, profile, h('p', { class: 'hint' }, 'Die Werte sind für 2026.38.5.12 vorbelegt und müssen normalerweise nicht eingetippt werden. Offline geprüft, Live-Abgleich steht aus. GPS wird auf drei Nachkommastellen gerundet.')));
      }
      if (group[0] === 'Verbindung') root.append(card);
      else advanced.append(card);
    });
    root.append(advanced);
    var reload = h('button', { type: 'button', 'aria-label': 'Einstellungen neu laden' }, 'Neu laden');
    reload.addEventListener('click', function () {
      if (busy) return;
      loadSettings().then(function () { say('Einstellungen neu geladen.'); }).catch(function () { say('Einstellungen konnten nicht geladen werden.', 'bad'); });
    });
    root.append(h('div', { class: 'actions' }, saveButton, reload), message);
    saveButton.disabled = false;
    saveButton.addEventListener('click', save);
  }
  function controls() {
    Object.keys(fields).forEach(function (id) {
      fields[id].input.disabled = busy || pluginMode || records[id].available === false;
      if (fields[id].clear) fields[id].clear.disabled = fields[id].input.disabled;
    });
    saveButton.disabled = busy || pluginMode || writeBlocked || records.enabled.available === false;
    if (profileButton) profileButton.disabled = busy || pluginMode;
    saveButton.textContent = pluginMode ? 'Konfiguration am Handy verwalten' : 'Einstellungen speichern';
  }
  function settingsError(error) {
    settingsReady = false;
    writeBlocked = error && error.code === 'forbidden';
    var code = error && error.code;
    connection.textContent = 'Gespeicherte Werte konnten nicht geladen werden. Die Felder zeigen lokale Vorgaben bzw. deine Eingaben. ' +
      (writeBlocked ? 'CoilShift verweigert den Zugriff; Speichern ist gesperrt.' : 'Du kannst Werte eingeben und Speichern versuchen; erst die Antwort bestätigt die Übernahme.') +
      (code && /^[a-z_]{1,40}$/.test(code) ? ' (' + code + ')' : '');
    connection.setAttribute('class', 'notice bad'); controls();
  }
  function loadSettings() {
    if (loadingSettings) return Promise.resolve();
    loadingSettings = true;
    // Use the raw SDK reply: settingList would silently turn unsupported shapes
    // into an empty array and hide the distinction from an actual empty reply.
    return bridge.data.get('plugin-settings.json').then(function (text) {
      var local = JSON.parse(text);
      if (local.source !== 'plugin' || !Array.isArray(local.settings)) throw new Error('not local');
      return local;
    }).catch(function () { return bridge.request('settings.get'); }).then(function (reply) {
      pluginMode = !!reply && reply.source === 'plugin';
      var list = window.csdkPanel.settingList(reply), missing = [], locked = [];
      Object.keys(fields).forEach(function (id) {
        var field = fields[id], setting = window.csdkPanel.findSetting(list, id);
        if (!setting) { missing.push(id); return; }
        records[id] = setting;
        if (setting.available === false) locked.push(id);
        if (dirty[id] && !pluginMode) return;
        if (pluginMode) dirty[id] = false; // Never replace a draft during a retry.
        if (field.type === 'secret') {
          field.input.value = ''; cleared[id] = false;
          field.input.setAttribute('placeholder', setting.value && setting.value.set ? 'Gespeichert · unverändert lassen' : 'Noch nicht gespeichert');
        } else if (field.type === 'bool') field.input.checked = setting.value === true || setting.value === 'true';
        else field.input.value = setting.value == null ? '' : String(setting.value);
      });
      settingsReady = missing.length === 0;
      writeBlocked = false;
      if (missing.length) {
        var shape = Array.isArray(reply) ? 'Liste' : reply && Array.isArray(reply.settings) ? 'settings-Liste' : reply === null ? 'null' : typeof reply;
        connection.textContent = 'CoilShift liefert ' + list.length + ' Einstellungen (Antwort: ' + shape + '). Gespeicherte Werte sind nicht vollständig bekannt. Lokale Vorgaben und eigene Eingaben bleiben bearbeitbar. Speichern wird über CoilShift angefordert; eine Übernahme ist noch nicht bestätigt.';
        connection.setAttribute('class', 'notice bad');
      } else {
        connection.textContent = pluginMode ? 'Direkt im Plugin gespeichert und vom Dienst verwendet. Zum Ändern die Handy-Seite verwenden (für einen neuen QR-Code Plugin-Dienst neu starten).' : locked.length ? 'CoilShift sperrt: ' + locked.join(', ') : 'Einstellungen verbunden.';
        connection.setAttribute('class', locked.length ? 'notice bad' : 'notice ok');
      }
      controls();
    }).then(function () { loadingSettings = false; }, function (error) {
      loadingSettings = false; settingsError(error); throw error;
    });
  }
  function loadPhone() {
    bridge.data.get('phone-setup.json').then(function (text) {
      var info = JSON.parse(text);
      if (info.schema !== 1) return;
      phoneQR.style.display = 'none'; phoneAddresses.replaceChildren();
      if (info.state === 'saved') { phoneNote.textContent = 'Verschlüsselt im Plugin gespeichert. Der Dienst übernimmt die Konfiguration automatisch.'; return; }
      if (info.state === 'sent') { phoneNote.textContent = 'Vom Handy übertragen. Eingaben unten prüfen und Einstellungen speichern.'; return; }
      if (info.state === 'expired') { phoneNote.textContent = 'Einrichtungsfenster abgelaufen. Für einen neuen QR-Code den Plugin-Dienst neu starten.'; return; }
      if (info.state !== 'ready') { phoneNote.textContent = 'Handy-Eingabe konnte nicht gestartet werden.'; return; }
      phoneLinks = (info.addresses || []).filter(function (entry) {
        return typeof entry.url === 'string' && /^https:\/\/[0-9.]+:[0-9]+\/#([a-f0-9]{48})$/.test(entry.url) &&
          typeof entry.qr === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(entry.qr);
      });
      if (!phoneLinks.length) { phoneNote.textContent = 'Dienst läuft, aber keine lokale oder Tailscale-IPv4-Adresse gefunden. Auto mit dem WLAN verbinden und Plugin-Dienst neu starten.'; return; }
      function show(entry) { phoneQR.setAttribute('src',entry.qr); phoneQR.style.display='block'; phoneNote.textContent='QR-Code scannen. Adresse: '+entry.url.split('/#')[0]; }
      show(phoneLinks[0]);
      if (phoneLinks.length > 1) phoneLinks.forEach(function(entry,index){var button=h('button',{type:'button'},'Adresse '+(index+1));button.addEventListener('click',function(){show(entry);});phoneAddresses.append(button);});
    }).catch(function () { phoneQR.style.display='none'; phoneNote.textContent='Noch kein Lebenszeichen der Handy-Eingabe. Dienststart prüfen und nach dem Update neu laden.'; });
    bridge.data.get('phone-input.json').then(function (text) {
      var input=JSON.parse(text);
      if (busy || input.schema!==1 || typeof input.id!=='string' || input.id===phoneInputID || typeof input.expires!=='number' || input.expires*1000<Date.now()) return;
      var values=input.values;
      if (!values || typeof values!=='object') return;
      var imported = 0;
      ['url','username','password','access_token'].forEach(function(id){
        if (typeof values[id]==='string' && !fields[id].input.disabled && (values[id]!=='' || (id!=='password' && id!=='access_token'))) {
          fields[id].input.value=values[id];dirty[id]=true;cleared[id]=false;imported++;
        }
      });
      if (!imported) { say('Vom Handy empfangen, aber CoilShift sperrt die Eingabefelder. Noch nicht in das Formular übernommen.', 'bad'); return; }
      phoneInputID=input.id;
      say('Vom Handy übernommen. Jetzt Werte prüfen, bei Bedarf aktivieren und Einstellungen speichern.');
    }).catch(function () {});
  }
  function loadStatus() {
    return bridge.status().then(function (status) {
      state.textContent = (status && status.state ? status.state : 'Unbekannt') + (status && status.reason ? ' · ' + status.reason : '');
    }, function () { state.textContent = 'Status momentan nicht erreichbar.'; });
  }
  function getValue(id) {
    var field = fields[id];
    return field.type === 'bool' ? (field.input.checked ? 'true' : 'false') : field.input.value;
  }
  function validate() {
    var url = getValue('url');
    if (url && !/^https:\/\/[^\s/?#@]+(?::[0-9]+)?(?:\/[^?#\s]*)?$/.test(url)) throw new Error('Bitte eine HTTPS-Basis-URL ohne Zugangsdaten, Query oder Fragment eintragen.');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(getValue('entity_prefix'))) throw new Error('Entitätsname: Kleinbuchstaben, Ziffern und Unterstriche; mit einem Buchstaben beginnen.');
    var interval = getValue('interval');
    if (!/^\d+$/.test(interval) || +interval < 5 || +interval > 300) throw new Error('Das Intervall muss eine ganze Zahl zwischen 5 und 300 sein.');
    ['latitude_dv','longitude_dv','speed_dv','door_dv','soc_dv'].forEach(function (id) {
      var value = getValue(id);
      if (value && !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value)) throw new Error('Ungültiger DataValue-Name: ' + value);
    });
    if (getValue('enabled') === 'true' && !url) throw new Error('Zum Aktivieren bitte die Home-Assistant-URL eintragen.');
  }
  function save() {
    if (busy || saveButton.disabled) return;
    try { validate(); } catch (error) { say(error.message, 'bad'); return; }
    var jobs = [], enabled = getValue('enabled');
    var wasEnabled = records.enabled.value === true || records.enabled.value === 'true';
    var unconfirmed = !settingsReady;
    Object.keys(fields).forEach(function (id) {
      if (id === 'enabled' || fields[id].input.disabled) return;
      var field = fields[id], value = getValue(id);
      if (field.type === 'secret') { if (cleared[id] || value !== '') jobs.push([id, cleared[id] ? '' : value]); }
      else if (dirty[id] || String(records[id].value) !== value) jobs.push([id, value]);
    });
    if (!jobs.length && !dirty.enabled && enabled === (wasEnabled ? 'true' : 'false')) { say('Keine Änderungen.'); return; }
    busy = true; controls(); say('Wird gespeichert …');
    // A read failure never grants extra rights. Every write still passes through
    // the SDK host, which enforces package ownership and settings.write.
    var chain = Promise.resolve();
    if (wasEnabled || unconfirmed) chain = chain.then(function () { return bridge.settings.set(records.enabled.id, 'false').then(function () { records.enabled.value = 'false'; dirty.enabled = true; }); });
    jobs.forEach(function (job) { chain = chain.then(function () {
      return bridge.settings.set(records[job[0]].id, job[1]).then(function () {
        records[job[0]].value = job[1]; dirty[job[0]] = false;
        if (fields[job[0]].type === 'secret') { fields[job[0]].input.value = ''; cleared[job[0]] = false; }
      });
    }); });
    chain = chain.then(function () { return bridge.settings.set(records.enabled.id, enabled); });
    return chain.then(function () {
      records.enabled.value = enabled; dirty.enabled = false;
      return loadSettings();
    }).then(function () {
      say(settingsReady ? 'Gespeichert. Der Dienst übernimmt die Einstellungen automatisch.' : 'CoilShift hat die Schreibvorgänge bestätigt. Das Zurücklesen ist weiterhin nicht möglich; die Übernahme am Fahrzeug ist damit noch nicht geprüft.', 'ok');
      return loadStatus();
    }).catch(function (error) {
      var code = error && error.code;
      say('CoilShift konnte das Speichern nicht vollständig bestätigen' + (code && /^[a-z_]{1,40}$/.test(code) ? ' (' + code + ')' : '') + '. Ein Teil kann bereits gespeichert sein; der Dienst kann deaktiviert bleiben. Deine noch nicht gespeicherten Eingaben bleiben erhalten.', 'bad');
    }).then(function () { busy = false; controls(); });
  }
  build(); bridge.applyChrome(document);
  loadSettings().catch(function (error) { say(error.message || 'Einstellungen konnten nicht geladen werden.', 'bad'); });
  loadStatus(); loadPhone();
  window.setInterval(function () {
    loadStatus(); loadPhone();
    // Retry a late app/manifest handshake without overwriting an active editor.
    if ((!settingsReady || pluginMode || !Object.keys(dirty).some(function(id){return dirty[id];})) && !busy) loadSettings().catch(function () {});
  }, 5000);
})();

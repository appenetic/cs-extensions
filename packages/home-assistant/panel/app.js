(function () {
  'use strict';
  var bridge = window.csdkPanel.createClient(window);
  var root = document.getElementById('root');
  var fields = {}, records = {}, cleared = {}, busy = false;
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
  var state = h('div', { class: 'notice', 'aria-live': 'polite', id: 'package-status' }, 'Status wird geladen …');
  var saveButton = h('button', { type: 'button', class: 'primary', 'aria-label': 'Einstellungen speichern' }, 'Einstellungen speichern');
  saveButton.disabled = true;
  function say(text, tone) { message.textContent = text; message.setAttribute('class', tone || ''); }
  function build() {
    root.replaceChildren(h('h1', {}, 'Home Assistant'), h('p', { class: 'subtitle' }, 'Verbindung und Fahrzeugdaten konfigurieren.'), state);
    groups.forEach(function (group) {
      var card = h('section', { class: 'card' }, h('h2', {}, group[0]));
      group[1].forEach(function (spec) {
        var id = spec[0], type = spec[2];
        var input = h(type === 'enum' ? 'select' : 'input', { id: id, 'aria-label': spec[1] });
        input.disabled = true;
        if (type !== 'enum') input.setAttribute('type', type === 'bool' ? 'checkbox' : type === 'secret' ? 'password' : type);
        if (type === 'secret') input.setAttribute('autocomplete', 'new-password');
        if (type === 'number') { input.setAttribute('min', '5'); input.setAttribute('max', '300'); input.setAttribute('step', '1'); }
        var control = input;
        if (type === 'enum') [['kph','km/h'],['mps','m/s'],['mph','mph']].forEach(function (choice) { input.append(h('option', { value: choice[0] }, choice[1])); });
        if (type === 'secret') {
          var clear = h('button', { type: 'button', 'aria-label': spec[1] + ' löschen' }, 'Löschen');
          clear.disabled = true;
          clear.addEventListener('click', function () { cleared[id] = true; input.value = ''; input.setAttribute('placeholder', 'Wird beim Speichern gelöscht'); });
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
        profile.addEventListener('click', function () {
          if (busy || saveButton.disabled) return;
          var values = { latitude_dv: 'NAV_vehicleLatitude', longitude_dv: 'NAV_vehicleLongitude', speed_dv: 'NAV_vehicleSpeedMph', speed_unit: 'mph', door_dv: 'VAPI_driverDoor', soc_dv: 'VAPI_batteryLevel' };
          Object.keys(values).forEach(function (id) { if (!fields[id].input.disabled) fields[id].input.value = values[id]; });
          say('Firmware-Profil eingetragen. Zum Übernehmen speichern.');
        });
        card.append(profile, h('p', { class: 'hint' }, 'Profil für 2026.38.5.12: offline geprüft, Live-Abgleich steht aus. GPS wird über diesen Leseweg auf drei Nachkommastellen gerundet.'));
      }
      root.append(card);
    });
    var reload = h('button', { type: 'button', 'aria-label': 'Einstellungen neu laden' }, 'Neu laden');
    reload.addEventListener('click', function () {
      if (busy) return;
      loadSettings().then(function () { say('Einstellungen neu geladen.'); }).catch(function () { say('Einstellungen konnten nicht geladen werden.', 'bad'); });
    });
    root.append(h('div', { class: 'actions' }, saveButton, reload), message);
    saveButton.addEventListener('click', save);
  }
  function loadSettings() {
    return bridge.settings.get().then(function (list) {
      var missing = [];
      Object.keys(fields).forEach(function (id) {
        var field = fields[id], setting = window.csdkPanel.findSetting(list, id);
        records[id] = setting;
        field.input.disabled = !setting || setting.available === false;
        if (field.clear) field.clear.disabled = field.input.disabled;
        if (!setting) { missing.push(id); return; }
        if (field.type === 'secret') {
          field.input.value = ''; cleared[id] = false;
          field.input.setAttribute('placeholder', setting.value && setting.value.set ? 'Gespeichert · unverändert lassen' : 'Noch nicht gespeichert');
        } else if (field.type === 'bool') field.input.checked = setting.value === true || setting.value === 'true';
        else field.input.value = setting.value == null ? '' : String(setting.value);
      });
      saveButton.disabled = missing.length > 0;
      if (missing.length) throw new Error('Einstellungen fehlen. Bitte Paket und CoilShift aktualisieren.');
    });
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
    var jobs = [], enabled = getValue('enabled'), wasEnabled = records.enabled.value === true || records.enabled.value === 'true';
    Object.keys(fields).forEach(function (id) {
      if (id === 'enabled' || fields[id].input.disabled) return;
      var field = fields[id], value = getValue(id);
      if (field.type === 'secret') { if (cleared[id] || value !== '') jobs.push([id, cleared[id] ? '' : value]); }
      else if (String(records[id].value) !== value) jobs.push([id, value]);
    });
    if (!jobs.length && enabled === (wasEnabled ? 'true' : 'false')) { say('Keine Änderungen.'); return; }
    busy = true; saveButton.disabled = true;
    Object.keys(fields).forEach(function (id) { fields[id].input.disabled = true; if (fields[id].clear) fields[id].clear.disabled = true; });
    say('Wird gespeichert …');
    // Keep the service disabled during partial updates. Enable only after every
    // connection/secret setting has been saved successfully.
    var chain = Promise.resolve();
    if (wasEnabled) chain = chain.then(function () { return bridge.settings.set(records.enabled.id, 'false'); });
    jobs.forEach(function (job) { chain = chain.then(function () {
      return bridge.settings.set(records[job[0]].id, job[1]).then(function () {
        if (fields[job[0]].type === 'secret') { fields[job[0]].input.value = ''; cleared[job[0]] = false; }
      });
    }); });
    chain = chain.then(function () { return bridge.settings.set(records.enabled.id, enabled); });
    return chain.then(loadSettings).then(function () { say('Gespeichert. Der Dienst übernimmt die Einstellungen automatisch.', 'ok'); return loadStatus(); })
      .catch(function () { say('Speichern fehlgeschlagen. Ein Teil kann bereits gespeichert sein. Bitte Einstellungen neu laden und prüfen; nach einem Fehler bleibt der Dienst gegebenenfalls deaktiviert.', 'bad'); })
      .then(function () {
        busy = false;
        // Read the actual state after a partial failure, never claim atomic saves.
        return loadSettings().catch(function () { saveButton.disabled = true; });
      });
  }
  build(); bridge.applyChrome(document);
  loadSettings().catch(function (error) { say(error.message || 'Einstellungen konnten nicht geladen werden.', 'bad'); });
  loadStatus();
  window.setInterval(loadStatus, 5000);
})();

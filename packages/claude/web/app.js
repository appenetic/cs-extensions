// The Claude app on the MCU, the launcher tile: a page the package's web service
// serves, talking to that service on its own origin with the token it gets from
// /api/bootstrap. Plain ES5, no build step; everything from the car or the Mac
// is shown with textContent, never as markup. The text fields are built once and
// never moved, so an update does not close the Tesla keyboard while dictating.
(function () {
  'use strict';

  var root = document.getElementById('root');
  var api = null;
  var view = null;
  var rev = -1;
  var selected = '';
  var focused = false;
  var seenPrompt = '';
  var screen = 'sessions';
  var drafts = {};
  var picks = {};
  var sending = false;
  var mode = 'starting';
  var els = {};

  function h(tag, attrs) {
    var element = document.createElement(tag);
    var keys = Object.keys(attrs || {});
    for (var i = 0; i < keys.length; i++) element.setAttribute(keys[i], attrs[keys[i]]);
    for (var j = 2; j < arguments.length; j++) element.append(arguments[j]);
    return element;
  }
  function button(label, attrs, onClick) {
    var b = h('button', attrs, label);
    b.addEventListener('click', onClick);
    return b;
  }
  function show(element, visible) {
    if (visible) element.removeAttribute('hidden');
    else element.setAttribute('hidden', '');
  }
  function say(text, tone) {
    els.flash.textContent = text || '';
    els.flash.setAttribute('class', 'flash ' + (tone || ''));
  }
  function trim(text) {
    return String(text || '').replace(/^\s+|\s+$/g, '');
  }

  // ------------------------------------------------------------ markdown

  // Claude answers in Markdown. The app draws its common parts as elements,
  // built from text nodes only: nothing in a message ever becomes HTML. Links
  // keep their text; the car does not open them.
  var INLINE = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*\s](?:[^*]*[^*\s])?)\*|~~([^~]+)~~|\[([^\]]+)\]\([^)\s]+\)/g;
  function inline(text) {
    var out = [];
    var last = 0;
    var m;
    INLINE.lastIndex = 0;
    var re = new RegExp(INLINE.source, 'g');
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1] || m[2]) out.push(h.apply(null, ['strong', {}].concat(inline(m[1] || m[2]))));
      else if (m[3]) out.push(h('code', {}, m[3]));
      else if (m[4]) out.push(h.apply(null, ['em', {}].concat(inline(m[4]))));
      else if (m[5]) out.push(h('s', {}, m[5]));
      else out.push(m[6]);
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function lineBreaks(lines) {
    var out = [];
    lines.forEach(function (line, i) {
      if (i) out.push(h('br', {}));
      out = out.concat(inline(trim(line)));
    });
    return out;
  }
  var ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  function cells(line) {
    var s = trim(line).replace(/\\\|/g, '\u0000');
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return trim(c.replace(/\u0000/g, '|')); });
  }
  function table(lines, i, box) {
    var head = cells(lines[i]);
    var body = h('tbody', {});
    for (i += 2; i < lines.length && lines[i].indexOf('|') >= 0 && trim(lines[i]); i++) {
      var row = cells(lines[i]);
      body.append(h.apply(null, ['tr', {}].concat(head.map(function (x, c) {
        return h.apply(null, ['td', {}].concat(inline(row[c] || '')));
      }))));
    }
    var top = h.apply(null, ['tr', {}].concat(head.map(function (c) { return h.apply(null, ['th', {}].concat(inline(c))); })));
    box.append(h('div', { class: 'table' }, h('table', {}, h('thead', {}, top), body)));
    return i;
  }
  function list(lines, i, box) {
    var first = ITEM.exec(lines[i]);
    var indent = first[1].length;
    var ordered = /\d/.test(first[2]);
    var el = h(ordered ? 'ol' : 'ul', {});
    if (ordered && parseInt(first[2], 10) !== 1) el.setAttribute('start', String(parseInt(first[2], 10)));
    var li = null;
    while (i < lines.length) {
      var line = lines[i];
      var m = ITEM.exec(line);
      if (!trim(line)) {
        var next = ITEM.exec(lines[i + 1] || '');
        if (next && next[1].length >= indent) {
          i++;
          continue;
        }
        break;
      }
      if (m && m[1].length === indent) {
        li = h.apply(null, ['li', {}].concat(inline(m[3])));
        el.append(li);
        i++;
      } else if (m && m[1].length > indent && li) {
        i = list(lines, i, li);
      } else if (!m && /^\s+\S/.test(line) && li) {
        li.append.apply(li, [h('br', {})].concat(inline(trim(line))));
        i++;
      } else {
        break;
      }
    }
    box.append(el);
    return i;
  }
  function markdown(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var box = h('div', { class: 'text md' });
    var para = [];
    var flush = function () {
      if (para.length) box.append(h.apply(null, ['p', {}].concat(lineBreaks(para))));
      para = [];
    };
    for (var i = 0; i < lines.length; ) {
      var line = lines[i];
      var heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (/^\s*```/.test(line)) {
        flush();
        var code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        box.append(h('pre', { class: 'code' }, code.join('\n')));
        i++;
      } else if (!trim(line)) {
        flush();
        i++;
      } else if (heading) {
        flush();
        box.append(h.apply(null, ['h4', {}].concat(inline(heading[1]))));
        i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        box.append(h('hr', {}));
        i++;
      } else if (line.indexOf('|') >= 0 && RULE.test(lines[i + 1] || '')) {
        flush();
        i = table(lines, i, box);
      } else if (ITEM.test(line)) {
        flush();
        i = list(lines, i, box);
      } else if (/^\s*>/.test(line)) {
        flush();
        var quote = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
        box.append(h('blockquote', {}, markdown(quote.join('\n'))));
      } else {
        para.push(line);
        i++;
      }
    }
    flush();
    return box;
  }

  // ------------------------------------------------------------ transport

  function request(method, path, body) {
    var headers = { Authorization: 'Bearer ' + api.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return window
      .fetch(api.base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
      .then(function (response) {
        return response.json().then(
          function (data) {
            if (!response.ok) throw new Error((data && data.message) || 'HTTP ' + response.status);
            return data;
          },
          function () {
            throw new Error('HTTP ' + response.status);
          }
        );
      });
  }

  function connect() {
    return window
      .fetch('/api/bootstrap', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('bootstrap');
        return response.json();
      })
      .then(function (data) {
        api = { base: '', token: data.token };
      });
  }

  function loop() {
    request('GET', '/api/view?since=' + rev + '&wait=25').then(
      function (data) {
        update(data);
        window.setTimeout(loop, 50);
      },
      function () {
        mode = 'retry';
        render();
        window.setTimeout(loop, 3000);
      }
    );
  }

  function start() {
    connect().then(
      function () {
        mode = 'live';
        audioDiag();
        loop();
      },
      function () {
        mode = 'retry';
        render();
        window.setTimeout(start, 3000);
      }
    );
  }

  function update(data) {
    if (!data || typeof data !== 'object') return;
    view = data;
    if (typeof data.rev === 'number') rev = data.rev;
    mode = 'live';
    if (data.theme) document.documentElement.setAttribute('data-theme', data.theme === 'day' ? 'light' : 'dark');
    render();
  }

  // ------------------------------------------------------------ actions

  function act(path, body, done) {
    if (sending || mode !== 'live') return;
    sending = true;
    render();
    request('POST', path, body).then(
      function (result) {
        sending = false;
        if (done) done(result);
        render();
      },
      function (error) {
        sending = false;
        say(error.message || 'Senden fehlgeschlagen.', 'bad');
        render();
      }
    );
  }

  var HOW = { hook: 'an die wartende Frage', inbox: 'in die laufende Sitzung', resume: 'als Fortsetzung im Hintergrund', fork: 'als Kopie im Hintergrund' };

  function answer(session, prompt, fields, label, after) {
    var body = { session: session.id, prompt: prompt ? prompt.id : '', source: 'touch' };
    var keys = Object.keys(fields);
    for (var i = 0; i < keys.length; i++) body[keys[i]] = fields[keys[i]];
    act('/api/reply', body, function (result) {
      picks = {};
      if (after) after();
      say(label + (HOW[result.delivered] ? ' · ' + HOW[result.delivered] : '') + '.', 'ok');
    });
  }

  // ------------------------------------------------------------ helpers

  // Sessions with an open question first, then by last activity as the bridge
  // sends them.
  function sessions() {
    var list = (view && view.sessions) || [];
    return list.filter(function (x) { return x.pending; }).concat(list.filter(function (x) { return !x.pending; }));
  }
  function current() {
    var list = sessions();
    for (var i = 0; i < list.length; i++) if (list[i].id === selected) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j].pending) return list[j];
    return list[0] || null;
  }
  function ago(ms) {
    if (!ms) return '';
    var now = view && view.now ? view.now * 1000 : Date.now();
    var minutes = Math.round((now - ms) / 60000);
    if (minutes < 1) return 'gerade eben';
    if (minutes < 60) return 'vor ' + minutes + ' Min.';
    if (minutes < 24 * 60) return 'vor ' + Math.round(minutes / 60) + ' Std.';
    var d = new Date(ms);
    return d.getDate() + '.' + (d.getMonth() + 1) + '.';
  }
  var STATUS = { working: 'arbeitet', waiting: 'wartet auf dich', idle: 'bereit', ended: 'beendet' };
  var KIND = { interactive: 'Terminal', background: 'Hintergrund', ended: 'beendet' };
  var ROLE = { user: 'Du', assistant: 'Claude', car: 'Aus dem Auto' };
  var LINK = { online: 'Verbunden', connecting: 'Verbinde …', offline: 'Mac nicht erreichbar', rejected: 'Kopplung abgelehnt', unpaired: 'Nicht gekoppelt' };
  // A small green dot that pulses while Claude works in a session. Every update
  // redraws the list, so its animation is locked to the clock: a new dot goes
  // on in step with the old one instead of starting over.
  function pulse(x) {
    if (x.status !== 'working' || x.pending) return '';
    var dot = h('span', { class: 'pulse', role: 'img', 'aria-label': 'arbeitet gerade' });
    dot.style.animationDelay = '-' + (Date.now() % 1600) + 'ms';
    return dot;
  }
  // Tool calls are not for reading while driving: a run of them is one small
  // bubble of dots. Its dots move while it is Claude's latest step; like the
  // pulse, their animation is locked to the clock across redraws.
  // ------------------------------------------------------------ images

  // Images pasted into a prompt come from the Mac one by one, made small there.
  // Each is fetched once and kept as its element, so an update neither loads nor
  // decodes it again; a tap shows it across the full width.
  var IMAGE_TYPES = { 'image/jpeg': true, 'image/png': true, 'image/gif': true, 'image/webp': true };
  var shots = {};
  function pictures(session, m) {
    var row = h('div', { class: 'shots' });
    for (var n = 0; n < Math.min(m.images, 4); n++) row.append(picture(session, m.id, n));
    return row;
  }
  function picture(session, message, n) {
    var key = session + ' ' + message + ' ' + n;
    if (shots[key]) return shots[key].node;
    var entry = (shots[key] = { state: '', zoom: false });
    entry.node = button('', { type: 'button', 'aria-label': 'Bild ' + (n + 1) }, function () {
      if (entry.state === 'failed') load();
      if (entry.state !== 'ok') return;
      entry.zoom = !entry.zoom;
      entry.node.setAttribute('class', entry.zoom ? 'shot zoom' : 'shot');
    });
    function load() {
      entry.state = 'loading';
      entry.node.setAttribute('class', 'shot wait');
      entry.node.textContent = 'Bild wird geladen …';
      request('GET', '/api/image?session=' + encodeURIComponent(session) + '&message=' + encodeURIComponent(message) + '&n=' + n)
        .then(function (d) {
          // Only a picture becomes the data URL, nothing else the answer holds.
          if (!d || !IMAGE_TYPES[d.type] || typeof d.data !== 'string' || !/^[A-Za-z0-9+\/]+={0,2}$/.test(d.data)) throw new Error('Kein gültiges Bild.');
          entry.state = 'ok';
          entry.node.setAttribute('class', 'shot');
          entry.node.replaceChildren(h('img', { src: 'data:' + d.type + ';base64,' + d.data, alt: 'Bild ' + (n + 1) }));
        })
        .catch(function (error) {
          entry.state = 'failed';
          entry.node.setAttribute('class', 'shot wait');
          entry.node.textContent = ((error && error.message) || 'Bild nicht verfügbar.') + ' Antippen für einen neuen Versuch.';
        });
    }
    load();
    return entry.node;
  }

  // ------------------------------------------------------------ reading aloud

  // The Mac reads Claude's answers with its own voice and the car plays the
  // sound: one answer at a time, a second tap stops it. What the car can play
  // goes to the Mac as diagnostics.
  var speakers = {};
  var playing = null;
  function speaker(session, m) {
    var key = session + ' ' + m.id;
    if (speakers[key]) return speakers[key].node;
    var entry = (speakers[key] = { state: '', sound: '' });
    entry.node = button('▶ Vorlesen', { type: 'button', class: 'chip speak' }, function () {
      if (entry.state === 'loading') return;
      if (playing && playing.entry === entry) return stop();
      stop();
      if (entry.sound) return play(entry);
      entry.state = 'loading';
      entry.node.textContent = 'Wird vorbereitet …';
      request('GET', '/api/speech?session=' + encodeURIComponent(session) + '&message=' + encodeURIComponent(m.id))
        .then(function (d) {
          if (!d || d.type !== 'audio/mp4' || typeof d.data !== 'string' || !/^[A-Za-z0-9+\/]+={0,2}$/.test(d.data)) throw new Error('Kein gültiger Ton.');
          entry.sound = 'data:' + d.type + ';base64,' + d.data;
          play(entry);
        })
        .catch(function (error) {
          entry.state = '';
          entry.node.textContent = ((error && error.message) || 'Vorlesen fehlgeschlagen.') + ' Nochmal antippen.';
        });
    });
    return entry.node;
  }
  function play(entry) {
    if (!window.Audio) {
      entry.state = '';
      entry.node.textContent = 'Hier lässt sich kein Ton abspielen.';
      return;
    }
    var audio = new window.Audio(entry.sound);
    playing = { entry: entry, audio: audio };
    entry.state = 'playing';
    entry.node.textContent = '■ Stopp';
    audio.onended = function () {
      if (playing && playing.audio === audio) stop();
    };
    var started = audio.play();
    if (!started || !started.then) return;
    started.then(
      function () {
        note('web.play', 'ok');
      },
      function (error) {
        var name = String((error && error.name) || error);
        note('web.play', name);
        if (playing && playing.audio === audio) playing = null;
        entry.state = '';
        entry.node.textContent = name === 'NotAllowedError' ? 'Das Auto lässt den Ton nicht zu. Einmal auf den Bildschirm tippen, dann nochmal.' : 'Der Ton lässt sich nicht abspielen (' + name + ').';
      }
    );
  }
  function stop() {
    if (!playing) return;
    var p = playing;
    playing = null;
    try {
      p.audio.pause();
    } catch (e) {}
    p.entry.state = '';
    p.entry.node.textContent = '▶ Vorlesen';
  }

  // note reports a value of the app to the car's diagnostics, once per change.
  var noted = {};
  function note(key, value) {
    if (!api || noted[key] === value) return;
    noted[key] = value;
    var body = {};
    body[key] = value;
    request('POST', '/api/diag', body).then(null, function () {
      delete noted[key];
    });
  }
  // Whether the car plays AAC, has voices of its own, and keeps the page when
  // another app is in front: what reading aloud on its own depends on.
  function audioDiag() {
    var aac = 'nein';
    var voices = 'fehlt';
    try {
      aac = (window.Audio && new window.Audio().canPlayType('audio/mp4; codecs="mp4a.40.2"')) || 'nein';
    } catch (e) {}
    try {
      if (window.speechSynthesis) voices = String(window.speechSynthesis.getVoices().length);
    } catch (e) {}
    note('web.audio', 'aac=' + aac + ' · stimmen=' + voices + ' · ' + (document.visibilityState || '?'));
  }

  function toolBubble(count, live) {
    var dots = h('span', { class: 'typing' + (live ? ' live' : ''), role: 'img',
      'aria-label': count > 1 ? count + ' Werkzeugaufrufe' : 'ein Werkzeugaufruf' });
    var phase = Date.now() % 1200;
    for (var i = 0; i < 3; i++) {
      var dot = h('i', {});
      if (live) dot.style.animationDelay = (i * 150 - phase) + 'ms';
      dots.append(dot);
    }
    return h('li', { class: 'message tool' }, dots);
  }
  function shortPath(path) {
    var parts = String(path || '').split('/');
    return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : path;
  }

  // ------------------------------------------------------------ skeleton

  function build() {
    els.link = h('span', { class: 'link', id: 'link-state' });
    els.away = button('Unterwegs-Modus', { type: 'button', class: 'toggle', 'aria-pressed': 'false', id: 'away' }, function () {
      var on = !(view && view.bridge && view.bridge.away);
      act('/api/away', { on: on }, function () {
        say(on ? 'Unterwegs-Modus an: Fragen und Freigaben warten auf deine Antwort im Auto.' : 'Unterwegs-Modus automatisch: an während der Fahrt.', 'ok');
      });
    });
    els.flash = h('p', { class: 'flash', 'aria-live': 'polite', id: 'flash' });
    els.pairing = h('section', { class: 'card pairing', id: 'pairing' });

    // The composer: one textarea for answers and new instructions.
    els.composer = h('textarea', { id: 'composer', rows: '3', 'aria-label': 'Nachricht an Claude', lang: 'de' });
    els.composer.addEventListener('input', function () {
      var s = current();
      if (s) drafts[s.id] = els.composer.value;
    });
    els.send = button('Senden', { type: 'button', class: 'primary', id: 'send' }, sendComposer);
    els.composerHint = h('p', { class: 'hint', id: 'composer-hint' });
    els.composerBox = h('section', { class: 'composer', id: 'composer-box' }, els.composer, h('div', { class: 'row' }, els.composerHint, els.send));

    // On a narrow screen the list and one session take turns; wide shows both.
    els.nav = h('nav', { class: 'sessions', id: 'sessions', 'aria-label': 'Sitzungen' });
    els.back = button('‹ Alle Sitzungen', { type: 'button', class: 'back', id: 'back' }, function () {
      focused = false;
      render();
    });
    els.head = h('div', { class: 'head', id: 'detail-head' });
    els.prompt = h('div', { id: 'prompt-box' });
    els.messages = h('ol', { class: 'messages', id: 'messages' });
    els.detail = h('section', { class: 'detail', id: 'detail' }, els.back, els.head, els.prompt, els.composerBox, els.messages);
    els.split = h('div', { class: 'split', id: 'split' }, els.nav, els.detail);

    // New background session: built once as well.
    els.project = h('select', { id: 'project', 'aria-label': 'Projekt' });
    els.task = h('textarea', { id: 'task', rows: '4', lang: 'de', 'aria-label': 'Auftrag', placeholder: 'Was soll Claude tun? Tippen oder diktieren.' });
    els.start = button('Im Hintergrund starten', { type: 'button', class: 'primary', id: 'start' }, function () {
      var task = trim(els.task.value);
      if (!task) return say('Bitte einen Auftrag eingeben.', 'bad');
      act('/api/start', { cwd: els.project.value, text: task, source: 'touch' }, function () {
        els.task.value = '';
        screen = 'sessions';
        say('Neue Sitzung gestartet. Sie erscheint gleich in der Liste.', 'ok');
      });
    });
    els.newCard = h('section', { class: 'card', id: 'new' },
      h('h2', {}, 'Neue Sitzung'),
      h('label', { for: 'project' }, 'Projekt'), els.project,
      h('label', { for: 'task' }, 'Auftrag'), els.task,
      h('div', { class: 'row' }, button('Abbrechen', { type: 'button', id: 'cancel-new' }, function () {
        screen = 'sessions';
        render();
      }), els.start),
      h('p', { class: 'hint' }, 'Startet claude --bg im gewählten Projekt auf dem Mac.'));

    els.diag = h('dl', { class: 'diag', id: 'diag' });
    els.techActions = h('div', { class: 'row' },
      button('Neuen Kopplungs-QR-Code', { type: 'button', id: 'pair-again' }, function () {
        act('/api/pairing', {}, function () {
          say('Kopplungsseite geöffnet, der QR-Code steht oben.', 'ok');
        });
      }),
      button('Entkoppeln', { type: 'button', class: 'danger', id: 'unpair' }, function () {
        act('/api/unpair', {}, function () {
          say('Entkoppelt.', 'ok');
        });
      }));
    els.tech = h('details', { class: 'card', id: 'technical' }, h('summary', {}, 'Technik'), els.diag, els.techActions);

    root.replaceChildren(
      h('header', { class: 'top' }, h('h1', {}, 'Claude Code'), els.link, els.away),
      els.flash,
      els.pairing,
      els.newCard,
      els.split,
      els.tech
    );
  }

  function sendComposer() {
    var s = current();
    var text = trim(els.composer.value);
    if (!s || !text) return;
    var p = s.pending;
    var clear = function () {
      drafts[s.id] = '';
      els.composer.value = '';
    };
    if (p && p.kind === 'question' && s.delivery === 'hook') {
      var answers = {};
      answers[p.questions[0].question] = text;
      answer(s, p, { answers: answers }, 'Antwort gesendet', clear);
    } else if (p && p.kind === 'permission' && s.delivery === 'hook') {
      answer(s, p, { decision: 'deny', text: text }, 'Abgelehnt mit Hinweis', clear);
    } else {
      answer(s, p && p.kind === 'input' ? p : null, { text: text }, s.delivery === 'resume' ? 'Fortgesetzt' : 'Gesendet', clear);
    }
  }

  // ------------------------------------------------------------ render

  function render() {
    var link = (view && view.link) || { state: 'connecting' };
    var bridgeName = (view && view.bridge && view.bridge.name) || link.bridge || '';
    var label = LINK[link.state] || link.state || '';
    if (mode === 'retry' && !view) label = 'Claude-Dienst im Auto startet …';
    els.link.textContent = label + (link.state === 'online' && bridgeName ? ' · ' + bridgeName : '');
    els.link.setAttribute('class', 'link ' + (link.state || ''));
    var away = Boolean(view && view.bridge && view.bridge.away);
    els.away.setAttribute('aria-pressed', away ? 'true' : 'false');
    els.away.textContent = away ? 'Unterwegs-Modus an' : 'Unterwegs-Modus aus';
    els.away.disabled = mode !== 'live' || link.state !== 'online' || sending;

    var pairingOpen = view && view.pairing && view.pairing.state === 'open';
    var needsPairing = !view || link.state === 'unpaired' || link.state === 'rejected' || pairingOpen;
    show(els.pairing, needsPairing);
    if (needsPairing) renderPairing(link);
    var paired = Boolean(view) && link.state !== 'unpaired';
    show(els.newCard, paired && screen === 'new');
    show(els.split, paired && screen !== 'new');
    if (paired && screen === 'new') renderNew();
    if (paired && screen !== 'new') renderSessions();
    renderTechnical(link);
  }

  // Two ways to pair: the code through the relay works everywhere; the QR code
  // needs the phone in the car's WLAN or tailnet.
  function renderPairing(link) {
    var pairing = (view && view.pairing) || {};
    var addresses = pairing.addresses || [];
    var code = pairing.state === 'open' ? pairing.code : '';
    var parts = [h('h2', {}, 'Mit dem Mac koppeln')];
    if (link.state === 'rejected' && link.error) parts.push(h('p', { class: 'bad' }, link.error));
    var install = h('li', {}, 'Auf dem Mac einmal das Claude-Code-Plugin installieren, im Terminal:',
      h('code', { class: 'cmd' }, 'claude plugin marketplace add appenetic/cs-extensions'),
      h('code', { class: 'cmd' }, 'claude plugin install coilshift@appenetic'),
      h('span', { class: 'hint' }, 'Oder in Claude Code dieselben Befehle mit /plugin statt claude plugin.'));
    var phone = [
      h('li', {}, 'In Claude Code ', h('code', {}, '/coilshift:pair'),
        ' ohne Code ausführen. Der Kopplungslink landet in der Zwischenablage, per Universal Clipboard auch auf dem iPhone.'),
      h('li', {}, 'Diesen QR-Code mit dem Handy scannen und das lokale Zertifikat einmal bestätigen.'),
      h('li', {}, 'Auf der Handy-Seite den Link einfügen und „Koppeln“ tippen.')];
    if (code) {
      parts.push(h('ol', { class: 'steps', id: 'setup-steps' }, install,
        h('li', {}, 'In einer neuen Claude-Code-Sitzung eingeben:',
          h('code', { class: 'cmd pair-code', id: 'pairing-code' }, '/coilshift:pair ' + code),
          h('span', { class: 'hint' }, 'Das klappt überall, ohne gemeinsames WLAN und ohne Tailscale: Der Mac schickt die Kopplung über ein Ende-zu-Ende-verschlüsseltes Internet-Relay.'))));
      if (pairing.message) parts.push(h('p', { class: 'hint', id: 'pairing-message' }, pairing.message));
      if (addresses.length) {
        parts.push(h('h3', {}, 'Oder mit dem Handy, im selben WLAN oder Tailnet wie das Auto'));
        parts.push(h.apply(null, ['ol', { class: 'steps' }].concat(phone)));
      }
    } else {
      parts.push(h.apply(null, ['ol', { class: 'steps', id: 'setup-steps' }, install].concat(phone)));
    }
    if (pairing.state === 'open' && addresses.length) {
      var shown = addresses[0];
      for (var i = 0; i < addresses.length; i++) if (addresses[i].url === picks.address) shown = addresses[i];
      parts.push(h('img', { class: 'qr', id: 'pairing-qr', src: shown.qr, alt: 'QR-Code für die Kopplung am Handy', width: '256', height: '256' }));
      var until = new Date(pairing.expires * 1000);
      parts.push(h('p', { class: 'hint', id: 'pairing-url' }, shown.url.split('#')[0] + ' · gültig bis ' + until.getHours() + ':' + ('0' + until.getMinutes()).slice(-2)));
      if (addresses.length > 1) {
        var row = h('div', { class: 'row' });
        addresses.forEach(function (a) {
          row.append(button(a.url.split('/')[2].split(':')[0], { type: 'button', class: a.url === shown.url ? 'chip on' : 'chip' }, function () {
            picks.address = a.url;
            render();
          }));
        });
        parts.push(row);
      }
    } else if (view && link.state === 'rejected' && mode === 'live') {
      var again = button('Neuen QR-Code anzeigen', { type: 'button', class: 'primary', id: 'pair-new' }, function () {
        act('/api/pairing', {});
      });
      again.disabled = sending;
      parts.push(again);
    } else if (!code) {
      parts.push(h('p', { class: 'hint' }, pairing.state === 'failed' ? 'Die Kopplungsseite konnte nicht gestartet werden.' : 'QR-Code wird vorbereitet …'));
    }
    els.pairing.replaceChildren.apply(els.pairing, parts);
  }

  function renderSessions() {
    var list = sessions();
    var s = current();
    if (s) selected = s.id;
    // A new open question brings its session to the front.
    if (s && s.pending && s.pending.id !== seenPrompt) {
      seenPrompt = s.pending.id;
      focused = true;
    }
    els.split.setAttribute('class', 'split' + (focused && s ? ' show-detail' : ''));
    var items = [];
    if (!list.length) items.push(h('p', { class: 'hint' }, 'Noch keine Sitzungen. Sie erscheinen, sobald Claude Code auf dem Mac läuft.'));
    list.forEach(function (x) {
      var item = button('', { type: 'button', class: 'session' + (s && x.id === s.id ? ' on' : '') + (x.pending ? ' asks' : ''), 'aria-label': x.title }, function () {
        selected = x.id;
        focused = true;
        say('');
        render();
      });
      item.append(
        h('span', { class: 'name' }, pulse(x), x.title),
        h('span', { class: 'meta' }, (x.pending ? 'Frage offen' : STATUS[x.status] || x.status) + ' · ' + (KIND[x.kind] || x.kind) + ' · ' + ago(x.updated))
      );
      items.push(item);
    });
    if ((view.projects || []).length && mode === 'live') {
      items.push(button('+ Neue Sitzung', { type: 'button', class: 'new', id: 'new-session' }, function () {
        screen = 'new';
        render();
      }));
    }
    if (view.hidden > 0 && mode === 'live') {
      var back = button(view.hidden + ' ausgeblendet · wieder einblenden', { type: 'button', class: 'new', id: 'unhide' }, function () {
        act('/api/unhide', {}, function () {
          say('Alle Sitzungen wieder eingeblendet.', 'ok');
        });
      });
      back.disabled = sending;
      items.push(back);
    }
    els.nav.replaceChildren.apply(els.nav, items);
    show(els.detail, Boolean(s));
    if (s) renderDetail(s);
  }

  function renderDetail(s) {
    // Hidden until something happens in the session again.
    var hide = button('Ausblenden', { type: 'button', class: 'chip', id: 'hide' }, function () {
      act('/api/hide', { session: s.id }, function () {
        selected = null;
        focused = false;
        say('Ausgeblendet. Die Sitzung kommt zurück, sobald dort wieder etwas passiert.', 'ok');
      });
    });
    hide.disabled = sending || mode !== 'live';
    els.head.replaceChildren(
      h('div', { class: 'title' },
        h('h2', {}, pulse(s), s.title),
        h('p', { class: 'hint' }, shortPath(s.cwd) + ' · ' + (KIND[s.kind] || s.kind) + ' · ' + (s.pending ? 'wartet auf dich' : STATUS[s.status] || s.status))),
      hide
    );
    els.prompt.replaceChildren();
    if (s.pending) els.prompt.append(promptCard(s, s.pending));
    // Newest first: the latest answer sits right under the answer field.
    var rows = [];
    var messages = s.messages || [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === 'tool') {
        var count = m.count || 1;
        while (i + 1 < messages.length && messages[i + 1].role === 'tool') count += messages[++i].count || 1;
        rows.unshift(toolBubble(count, i === messages.length - 1 && s.status === 'working' && !s.pending));
        continue;
      }
      // The images stand below the text instead of their "[Image #n]".
      var text = m.images ? trim(String(m.text || '').replace(/\[Image #\d+\]/g, '')) : m.text;
      var body = m.role === 'assistant' ? markdown(m.text) : h('span', { class: 'text' }, text);
      var item = h('li', { class: 'message ' + m.role }, h('span', { class: 'who' }, (ROLE[m.role] || m.role) + ' · ' + ago(m.at)), body);
      if (m.role === 'user' && m.images > 0) item.append(pictures(s.id, m));
      if (m.role === 'assistant' && m.text) item.append(speaker(s.id, m));
      rows.unshift(item);
    }
    if (!rows.length) rows.push(h('li', { class: 'hint' }, 'Noch kein Verlauf.'));
    els.messages.replaceChildren.apply(els.messages, rows);
    renderComposer(s);
  }

  function promptCard(s, p) {
    var live = mode === 'live' && s.delivery === 'hook' && !sending;
    var card = h('section', { class: 'card prompt', id: 'prompt', 'aria-live': 'polite' });
    var questions = p.questions || [];
    var collect = questions.length > 1 || (questions[0] && questions[0].multiSelect);
    if (p.kind === 'question') {
      questions.forEach(function (q, qi) {
        card.append(h('h3', {}, q.header ? q.header + ': ' + q.question : q.question));
        // One answer per row, like the card over the map: long labels stay whole.
        var row = h('div', { class: 'options stack' });
        (q.options || []).forEach(function (o, oi) {
          var key = qi + ':' + oi;
          var chosen = Boolean(picks[key]);
          var b = button(o.label, { type: 'button', class: 'option' + (chosen ? ' on' : ''), 'aria-label': o.label }, function () {
            if (collect) {
              if (!q.multiSelect) for (var k = 0; k < q.options.length; k++) delete picks[qi + ':' + k];
              if (chosen) delete picks[key];
              else picks[key] = true;
              render();
              return;
            }
            var answers = {};
            answers[q.question] = o.label;
            answer(s, p, { answers: answers }, 'Antwort gesendet');
          });
          b.disabled = !live;
          if (o.description) b.append(h('small', {}, o.description));
          row.append(b);
        });
        card.append(row);
      });
      if (collect) {
        var all = button('Antworten senden', { type: 'button', class: 'primary', id: 'send-picks' }, function () {
          var answers = {};
          questions.forEach(function (q, qi) {
            var labels = [];
            (q.options || []).forEach(function (o, oi) {
              if (picks[qi + ':' + oi]) labels.push(o.label);
            });
            if (labels.length) answers[q.question] = labels.join(', ');
          });
          if (!Object.keys(answers).length) return say('Bitte zuerst eine Antwort wählen.', 'bad');
          answer(s, p, { answers: answers }, 'Antworten gesendet');
        });
        all.disabled = !live;
        card.append(all);
      }
    } else if (p.kind === 'permission') {
      card.append(h('h3', {}, 'Freigabe: ' + (p.tool || 'Werkzeug')), h('pre', { class: 'detail-text' }, p.detail || p.text));
      var allow = button('Erlauben', { type: 'button', class: 'primary', id: 'allow' }, function () {
        answer(s, p, { decision: 'allow' }, 'Freigegeben');
      });
      var deny = button('Ablehnen', { type: 'button', class: 'danger', id: 'deny' }, function () {
        answer(s, p, { decision: 'deny' }, 'Abgelehnt');
      });
      allow.disabled = !live;
      deny.disabled = !live;
      card.append(h('div', { class: 'options' }, allow, deny));
    } else {
      card.append(h('h3', {}, 'Claude wartet auf dich'), markdown(p.text));
    }
    if (p.kind !== 'input' && s.delivery !== 'hook') {
      card.append(h('p', { class: 'hint' }, 'Diese Frage ist im Terminal auf dem Mac offen. Mit eingeschaltetem Unterwegs-Modus warten künftige Fragen auf deine Antwort im Auto.'));
    } else {
      card.append(h('p', { class: 'hint' }, 'Antwort per Tippen, über das Mikrofon der Tastatur oder mit der Sprachtaste: „Claude, …“'));
    }
    return card;
  }

  var HINTS = {
    inbox: 'Geht direkt in die laufende Sitzung. Diktieren über das Mikrofon der Tesla-Tastatur.',
    hook: 'Beantwortet die offene Frage mit eigenem Text.',
    resume: 'Setzt die beendete Sitzung auf dem Mac im Hintergrund fort.',
    fork: 'Diese Sitzung läuft ohne Postfach, weil sie vor dem Plugin gestartet wurde. Deine Nachricht startet eine Kopie im Hintergrund, die mit dem bisherigen Verlauf weiterarbeitet.'
  };

  function renderComposer(s) {
    var canSend = mode === 'live' && !sending && s.delivery !== '';
    if (els.composer.getAttribute('data-session') !== s.id) {
      els.composer.value = drafts[s.id] || '';
      els.composer.setAttribute('data-session', s.id);
    }
    els.composer.setAttribute('placeholder', s.delivery === 'resume' || s.delivery === 'fork' ? 'Woran soll Claude weiterarbeiten?' : 'Nachricht an Claude …');
    els.composer.disabled = !canSend;
    els.send.disabled = !canSend;
    els.send.textContent = sending ? 'Wird gesendet …' : s.delivery === 'resume' ? 'Fortsetzen' : s.delivery === 'fork' ? 'Als Kopie senden' : 'Senden';
    els.composerHint.textContent = canSend
      ? HINTS[s.delivery] || HINTS.inbox
      : mode !== 'live'
        ? 'Verbindung zum Claude-Dienst im Auto wird aufgebaut …'
        : 'Diese Sitzung nimmt gerade keinen Text an. Sie läuft vermutlich ohne das CoilShift-Plugin.';
  }

  function renderNew() {
    var projects = (view && view.projects) || [];
    var key = projects
      .map(function (p) {
        return p.cwd;
      })
      .join('\n');
    if (els.project.getAttribute('data-key') !== key) {
      var keep = els.project.value;
      els.project.replaceChildren.apply(els.project, projects.map(function (p) {
        return h('option', { value: p.cwd }, p.title + ' · ' + shortPath(p.cwd));
      }));
      els.project.setAttribute('data-key', key);
      if (keep) els.project.value = keep;
      else if (projects[0]) els.project.value = projects[0].cwd;
    }
    els.start.disabled = sending || mode !== 'live';
  }

  function renderTechnical(link) {
    var diag = (view && view.diag) || {};
    var rows = [
      ['Verbindung', (LINK[link.state] || link.state || '–') + (link.error ? ' · ' + link.error : '')],
      ['Bridge', view && view.bridge ? (view.bridge.name || '') + ' · ' + (view.bridge.version || '') : '–'],
      ['Weg zum Mac', !diag.route ? '–' : diag.route.indexOf('relay') === 0 ? 'Internet-Relay' + (diag.route.length > 6 ? ' · ' + diag.route.slice(6) : '') : 'direkt · ' + diag.route],
      ['Web-Port', diag['web.listen'] ? diag['web.listen'] + (diag['web.port'] ? ' · ' + diag['web.port'] + ' (' + (diag['web.mode'] || '') + ')' : '') : 'noch keine Meldung'],
      ['Web-Dienst', (diag['web.service'] || '–') + (diag['web.bind'] ? ' · Namespace ' + diag['web.bind'] : '')],
      ['Karte über der Navi', diag.card || 'noch keine Meldung'],
      ['Sprachtaste', diag.voice || 'noch keine Meldung'],
      ['Letzte Sprachantwort', diag['voice.last'] || '–'],
      ['Fahrstufe', (view && view.gear) || '–']
    ];
    var cells = [];
    rows.forEach(function (r) {
      cells.push(h('dt', {}, r[0]), h('dd', {}, r[1]));
    });
    els.diag.replaceChildren.apply(els.diag, cells);
    show(els.techActions, mode === 'live' && Boolean(view) && link.state !== 'unpaired');
  }

  build();
  render();
  start();
  try {
    document.addEventListener('visibilitychange', audioDiag);
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = audioDiag;
  } catch (e) {}
})();

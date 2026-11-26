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

  // The app speaks the car's language: German where the car is set to German,
  // English otherwise, as the service says in the view (lang). t picks between
  // a German and an English text; word reads a map of such pairs, and leaves a
  // key it does not know as it is.
  var lang = 'de';
  function t(de, en) {
    return lang === 'en' ? en : de;
  }
  function word(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key][lang === 'en' ? 1 : 0] : key;
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
    speak(data.lang === 'en' ? 'en' : 'de');
    render();
  }

  // Another language builds the page anew. What was typed stays: the answer
  // field from its draft, the task as it was. A sound playing stops; sounds
  // and pictures load again when shown.
  function speak(next) {
    if (next === lang) return;
    lang = next;
    document.documentElement.setAttribute('lang', lang);
    stop();
    speakers = {};
    shots = {};
    var task = els.task.value;
    build();
    els.task.value = task;
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
        say(error.message || t('Senden fehlgeschlagen.', 'Sending failed.'), 'bad');
        render();
      }
    );
  }

  var HOW = { hook: ['an die wartende Frage', 'to the waiting question'], inbox: ['in die laufende Sitzung', 'into the running session'],
    resume: ['als Fortsetzung im Hintergrund', 'as a continuation in the background'], fork: ['als Kopie im Hintergrund', 'as a copy in the background'] };

  function answer(session, prompt, fields, label, after) {
    var body = { session: session.id, prompt: prompt ? prompt.id : '', source: 'touch' };
    var keys = Object.keys(fields);
    for (var i = 0; i < keys.length; i++) body[keys[i]] = fields[keys[i]];
    act('/api/reply', body, function (result) {
      picks = {};
      if (after) after();
      say(label + (HOW[result.delivered] ? ' · ' + word(HOW, result.delivered) : '') + '.', 'ok');
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
    if (minutes < 1) return t('gerade eben', 'just now');
    if (minutes < 60) return t('vor ' + minutes + ' Min.', minutes + ' min ago');
    if (minutes < 24 * 60) return t('vor ' + Math.round(minutes / 60) + ' Std.', Math.round(minutes / 60) + ' h ago');
    var d = new Date(ms);
    return t(d.getDate() + '.' + (d.getMonth() + 1) + '.', MONTHS[d.getMonth()] + ' ' + d.getDate());
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var STATUS = { working: ['arbeitet', 'working'], waiting: ['wartet auf dich', 'waiting for you'], idle: ['bereit', 'ready'], ended: ['beendet', 'ended'] };
  var KIND = { interactive: ['Terminal', 'Terminal'], background: ['Hintergrund', 'Background'], ended: ['beendet', 'ended'] };
  var ROLE = { user: ['Du', 'You'], assistant: ['Claude', 'Claude'], car: ['Aus dem Auto', 'From the car'] };
  var LINK = { online: ['Verbunden', 'Connected'], connecting: ['Verbinde …', 'Connecting …'], offline: ['Mac nicht erreichbar', 'Mac not reachable'],
    rejected: ['Kopplung abgelehnt', 'Pairing refused'], unpaired: ['Nicht gekoppelt', 'Not paired'] };
  // A small green dot that pulses while Claude works in a session. Every update
  // redraws the list, so its animation is locked to the clock: a new dot goes
  // on in step with the old one instead of starting over.
  function pulse(x) {
    if (x.status !== 'working' || x.pending) return '';
    var dot = h('span', { class: 'pulse', role: 'img', 'aria-label': t('arbeitet gerade', 'working') });
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
    entry.node = button('', { type: 'button', 'aria-label': t('Bild ', 'Image ') + (n + 1) }, function () {
      if (entry.state === 'failed') load();
      if (entry.state !== 'ok') return;
      entry.zoom = !entry.zoom;
      entry.node.setAttribute('class', entry.zoom ? 'shot zoom' : 'shot');
    });
    function load() {
      entry.state = 'loading';
      entry.node.setAttribute('class', 'shot wait');
      entry.node.textContent = t('Bild wird geladen …', 'Loading image …');
      request('GET', '/api/image?session=' + encodeURIComponent(session) + '&message=' + encodeURIComponent(message) + '&n=' + n)
        .then(function (d) {
          // Only a picture becomes the data URL, nothing else the answer holds.
          if (!d || !IMAGE_TYPES[d.type] || typeof d.data !== 'string' || !/^[A-Za-z0-9+\/]+={0,2}$/.test(d.data)) throw new Error(t('Kein gültiges Bild.', 'Not a valid image.'));
          entry.state = 'ok';
          entry.node.setAttribute('class', 'shot');
          entry.node.replaceChildren(h('img', { src: 'data:' + d.type + ';base64,' + d.data, alt: t('Bild ', 'Image ') + (n + 1) }));
        })
        .catch(function (error) {
          entry.state = 'failed';
          entry.node.setAttribute('class', 'shot wait');
          entry.node.textContent = ((error && error.message) || t('Bild nicht verfügbar.', 'Image not available.')) + t(' Antippen für einen neuen Versuch.', ' Tap to try again.');
        });
    }
    load();
    return entry.node;
  }

  // ------------------------------------------------------------ reading aloud

  // The Mac reads Claude's answers with its own voice and the car plays the
  // sound: one answer at a time, a second tap stops it. The car's music pauses
  // meanwhile and plays on after. What the car can play goes to the Mac as
  // diagnostics.
  var speakers = {};
  var playing = null;
  function speaker(session, m) {
    var key = session + ' ' + m.id;
    if (speakers[key]) return speakers[key].node;
    var entry = (speakers[key] = { state: '', sound: '' });
    entry.node = button(t('▶ Vorlesen', '▶ Read aloud'), { type: 'button', class: 'chip speak' }, function () {
      if (entry.state === 'loading') return;
      if (playing && playing.entry === entry) return stop();
      // Another answer takes over: the music stays paused for it.
      stop(true);
      if (entry.sound) return play(entry);
      entry.state = 'loading';
      entry.node.textContent = t('Wird vorbereitet …', 'Preparing …');
      request('GET', '/api/speech?session=' + encodeURIComponent(session) + '&message=' + encodeURIComponent(m.id))
        .then(function (d) {
          if (!d || d.type !== 'audio/mp4' || typeof d.data !== 'string' || !/^[A-Za-z0-9+\/]+={0,2}$/.test(d.data)) throw new Error(t('Kein gültiger Ton.', 'Not a valid sound.'));
          entry.sound = 'data:' + d.type + ';base64,' + d.data;
          if (!playing) return play(entry);
          // Another answer started meanwhile; this one waits for a tap.
          entry.state = '';
          entry.node.textContent = t('▶ Vorlesen', '▶ Read aloud');
        })
        .catch(function (error) {
          entry.state = '';
          entry.node.textContent = ((error && error.message) || t('Vorlesen fehlgeschlagen.', 'Reading aloud failed.')) + t(' Nochmal antippen.', ' Tap again.');
          if (!playing) music('resume');
        });
    });
    return entry.node;
  }
  function play(entry) {
    if (!window.Audio) {
      entry.state = '';
      entry.node.textContent = t('Hier lässt sich kein Ton abspielen.', 'No sound can be played here.');
      music('resume');
      return;
    }
    var audio = new window.Audio(entry.sound);
    playing = { entry: entry, audio: audio };
    entry.state = 'playing';
    entry.node.textContent = t('■ Stopp', '■ Stop');
    audio.onended = function () {
      if (playing && playing.audio === audio) stop();
    };
    // The music pauses first, for about as long as the answer lasts (AAC at
    // 32 kbit/s); the answer is read either way.
    var seconds = isFinite(audio.duration) && audio.duration > 0 ? Math.ceil(audio.duration) : Math.ceil((entry.sound.length * 3) / 4 / 4000) + 3;
    music('pause', seconds).then(function () {
      if (!playing || playing.audio !== audio) return;
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
          entry.node.textContent = name === 'NotAllowedError'
            ? t('Das Auto lässt den Ton nicht zu. Einmal auf den Bildschirm tippen, dann nochmal.', 'The car does not allow the sound. Tap the screen once, then try again.')
            : t('Der Ton lässt sich nicht abspielen (', 'The sound cannot be played (') + name + ').';
          music('resume');
        }
      );
    });
  }
  // stop ends the answer that plays; the music plays on unless keep.
  function stop(keep) {
    if (!playing) return;
    var p = playing;
    playing = null;
    try {
      p.audio.pause();
      // Without its source the page's media session ends, and the car turns
      // from the browser back to the music before it plays on.
      p.audio.removeAttribute('src');
      p.audio.load();
    } catch (e) {}
    p.entry.state = '';
    p.entry.node.textContent = t('▶ Vorlesen', '▶ Read aloud');
    if (!keep) music('resume');
  }
  // music asks the car to pause its music for an answer, or to play it on.
  // It never fails: reading aloud does not wait for the music.
  function music(action, seconds) {
    var body = action === 'pause' ? { action: action, seconds: seconds } : { action: action };
    return request('POST', '/api/media', body).then(null, function () {
      return null;
    });
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
      'aria-label': count > 1 ? count + t(' Werkzeugaufrufe', ' tool calls') : t('ein Werkzeugaufruf', 'one tool call') });
    var phase = Date.now() % 1200;
    for (var i = 0; i < 3; i++) {
      var dot = h('i', {});
      if (live) dot.style.animationDelay = (i * 150 - phase) + 'ms';
      dots.append(dot);
    }
    return h('li', { class: 'message tool' }, dots);
  }
  // ------------------------------------------------------------ history

  // Claude's words on the way, background work that ended and sub-agents.
  // Their signs are drawn: the car's font has no check mark.
  var SIGNS = {
    done: ['M5 12.5 10 17.5 19 7'],
    failed: ['M7 7l10 10', 'M17 7 7 17'],
    stopped: ['M7 12h10'],
    notice: ['M12 7v6', 'M12 16.5v.5'],
    compact: ['M4 7h16', 'M7 12h10', 'M10 17h4'],
    agent: ['M6 8.5v7', 'M8.3 7.2 15.7 10.8']
  };
  function sign(name, size) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('aria-hidden', 'true');
    var paths = SIGNS[name] || [];
    for (var i = 0; i < paths.length; i++) {
      var path = document.createElementNS(NS, 'path');
      path.setAttribute('d', paths[i]);
      svg.appendChild(path);
    }
    // A sub-agent: one branching off the main line.
    var dots = name === 'agent' ? [[6, 6], [6, 18], [18, 12]] : [];
    for (var j = 0; j < dots.length; j++) {
      var dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(dots[j][0]));
      dot.setAttribute('cy', String(dots[j][1]));
      dot.setAttribute('r', '2.5');
      svg.appendChild(dot);
    }
    return svg;
  }
  function clock() {
    return view && view.now ? view.now * 1000 : Date.now();
  }
  function lasted(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return t(s + ' Sek.', s + ' s');
    var m = Math.round(s / 60);
    if (m < 60) return t(m + ' Min.', m + ' min');
    return t(Math.round(m / 60) + ' Std.', Math.round(m / 60) + ' h');
  }
  // plain is a report's beginning without its Markdown, for a few lines.
  function plain(text) {
    return trim(String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
      .replace(/(\*\*|\*)(\S[\s\S]*?)\1/g, '$2')
      .replace(/\s+/g, ' '));
  }
  var COMMAND = { done: ['Hintergrund-Befehl fertig', 'Background command finished'], failed: ['Hintergrund-Befehl fehlgeschlagen', 'Background command failed'],
    stopped: ['Hintergrund-Befehl abgebrochen', 'Background command stopped'] };
  // An event: a quiet line with its sign, what ended and when.
  function eventRow(m) {
    var title;
    var detail = [];
    var mark = m.state === 'failed' ? 'failed' : m.state === 'stopped' ? 'stopped' : 'done';
    if (m.kind === 'command') {
      title = word(COMMAND, mark);
      detail.push(t('„', '“') + m.text + t('“', '”'));
      if (typeof m.exit === 'number') detail.push(t('Exit-Code ', 'exit code ') + m.exit);
    } else if (m.kind === 'compact') {
      mark = 'compact';
      title = t('Verlauf zusammengefasst', 'History summarized');
      detail.push(t('Ältere Nachrichten stehen weiter im Terminal', 'Older messages are still in the terminal'));
    } else {
      if (mark === 'done') mark = 'notice';
      title = t('Meldung', 'Notice');
      detail.push(m.text);
    }
    detail.push(ago(m.at));
    return h('li', { class: 'event ' + mark },
      h('span', { class: 'badge' }, sign(mark)),
      h('span', { class: 'what' }, h('span', { class: 'title' }, title), h('span', { class: 'detail' }, detail.join(' · '))));
  }
  // A sub-agent: what it does and how it stands; its report opens on a tap.
  // Which reports are open stays across updates.
  var opened = {};
  function agentCard(s, m) {
    var state;
    if (m.state === 'running') {
      var dot = h('span', { class: 'pulse' });
      dot.style.animationDelay = '-' + (Date.now() % 1600) + 'ms';
      state = h('span', { class: 'state' }, dot, t('läuft · ', 'running · ') + lasted(clock() - m.at));
    } else if (m.state === 'done') {
      state = h('span', { class: 'state done' }, sign('done', 16), m.ended ? t('fertig nach ', 'done after ') + lasted(m.ended - m.at) : t('fertig', 'done'));
    } else {
      var stopped = m.state === 'stopped';
      state = h('span', { class: 'state ' + (stopped ? 'stopped' : 'failed') }, sign(stopped ? 'stopped' : 'failed', 16), stopped ? t('abgebrochen', 'stopped') : t('fehlgeschlagen', 'failed'));
    }
    var card = h('li', { class: 'message agent' },
      h('div', { class: 'head' },
        h('span', { class: 'badge' }, sign('agent', 20)),
        h('span', { class: 'what' }, h('span', { class: 'kind' }, t('Sub-Agent', 'Sub-agent') + (m.agent ? ' · ' + m.agent : '')), h('span', { class: 'name' }, m.text)),
        state));
    if (m.result) {
      var key = s.id + ' ' + m.id;
      var open = Boolean(opened[key]);
      card.append(open ? h('div', { class: 'result open' }, markdown(m.result)) : h('p', { class: 'result' }, plain(m.result)));
      card.append(button(open ? t('Weniger', 'Less') : t('Ergebnis lesen', 'Read result'), { type: 'button', class: 'chip' }, function () {
        opened[key] = !open;
        renderDetail(s);
      }));
    }
    return card;
  }
  function shortPath(path) {
    var parts = String(path || '').split('/');
    return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : path;
  }

  // ------------------------------------------------------------ skeleton

  function build() {
    els.link = h('span', { class: 'link', id: 'link-state' });
    els.away = button(t('Unterwegs-Modus', 'Away mode'), { type: 'button', class: 'toggle', 'aria-pressed': 'false', id: 'away' }, function () {
      var on = !(view && view.bridge && view.bridge.away);
      act('/api/away', { on: on }, function () {
        say(on ? t('Unterwegs-Modus an: Fragen und Freigaben warten auf deine Antwort im Auto.', 'Away mode on: questions and approvals wait for your answer in the car.')
          : t('Unterwegs-Modus automatisch: an während der Fahrt.', 'Away mode automatic: on while driving.'), 'ok');
      });
    });
    els.flash = h('p', { class: 'flash', 'aria-live': 'polite', id: 'flash' });
    els.pairing = h('section', { class: 'card pairing', id: 'pairing' });

    // The composer: one textarea for answers and new instructions.
    els.composer = h('textarea', { id: 'composer', rows: '3', 'aria-label': t('Nachricht an Claude', 'Message to Claude'), lang: lang });
    els.composer.addEventListener('input', function () {
      var s = current();
      if (s) drafts[s.id] = els.composer.value;
    });
    els.send = button(t('Senden', 'Send'), { type: 'button', class: 'primary', id: 'send' }, sendComposer);
    els.composerHint = h('p', { class: 'hint', id: 'composer-hint' });
    els.composerBox = h('section', { class: 'composer', id: 'composer-box' }, els.composer, h('div', { class: 'row' }, els.composerHint, els.send));

    // On a narrow screen the list and one session take turns; wide shows both.
    els.nav = h('nav', { class: 'sessions', id: 'sessions', 'aria-label': t('Sitzungen', 'Sessions') });
    els.back = button(t('‹ Alle Sitzungen', '‹ All sessions'), { type: 'button', class: 'back', id: 'back' }, function () {
      focused = false;
      render();
    });
    els.head = h('div', { class: 'head', id: 'detail-head' });
    els.prompt = h('div', { id: 'prompt-box' });
    els.messages = h('ol', { class: 'messages', id: 'messages' });
    els.detail = h('section', { class: 'detail', id: 'detail' }, els.back, els.head, els.prompt, els.composerBox, els.messages);
    els.split = h('div', { class: 'split', id: 'split' }, els.nav, els.detail);

    // New background session: built once as well.
    els.project = h('select', { id: 'project', 'aria-label': t('Projekt', 'Project') });
    els.task = h('textarea', { id: 'task', rows: '4', lang: lang, 'aria-label': t('Auftrag', 'Task'),
      placeholder: t('Was soll Claude tun? Tippen oder diktieren.', 'What should Claude do? Type or dictate.') });
    els.start = button(t('Im Hintergrund starten', 'Start in the background'), { type: 'button', class: 'primary', id: 'start' }, function () {
      var task = trim(els.task.value);
      if (!task) return say(t('Bitte einen Auftrag eingeben.', 'Please enter a task.'), 'bad');
      act('/api/start', { cwd: els.project.value, text: task, source: 'touch' }, function () {
        els.task.value = '';
        screen = 'sessions';
        say(t('Neue Sitzung gestartet. Sie erscheint gleich in der Liste.', 'New session started. It shows in the list in a moment.'), 'ok');
      });
    });
    els.newCard = h('section', { class: 'card', id: 'new' },
      h('h2', {}, t('Neue Sitzung', 'New session')),
      h('label', { for: 'project' }, t('Projekt', 'Project')), els.project,
      h('label', { for: 'task' }, t('Auftrag', 'Task')), els.task,
      h('div', { class: 'row' }, button(t('Abbrechen', 'Cancel'), { type: 'button', id: 'cancel-new' }, function () {
        screen = 'sessions';
        render();
      }), els.start),
      h('p', { class: 'hint' }, t('Startet claude --bg im gewählten Projekt auf dem Mac.', 'Runs claude --bg in the chosen project on the Mac.')));

    els.diag = h('dl', { class: 'diag', id: 'diag' });
    els.techActions = h('div', { class: 'row' },
      button(t('Neuen Kopplungs-QR-Code', 'New pairing QR code'), { type: 'button', id: 'pair-again' }, function () {
        act('/api/pairing', {}, function () {
          say(t('Kopplungsseite geöffnet, der QR-Code steht oben.', 'Pairing page opened, the QR code is at the top.'), 'ok');
        });
      }),
      button(t('Entkoppeln', 'Unpair'), { type: 'button', class: 'danger', id: 'unpair' }, function () {
        act('/api/unpair', {}, function () {
          say(t('Entkoppelt.', 'Unpaired.'), 'ok');
        });
      }));
    els.tech = h('details', { class: 'card', id: 'technical' }, h('summary', {}, t('Technik', 'Technical')), els.diag, els.techActions);

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
      answer(s, p, { answers: answers }, t('Antwort gesendet', 'Answer sent'), clear);
    } else if (p && p.kind === 'permission' && s.delivery === 'hook') {
      answer(s, p, { decision: 'deny', text: text }, t('Abgelehnt mit Hinweis', 'Denied with a note'), clear);
    } else {
      answer(s, p && p.kind === 'input' ? p : null, { text: text }, s.delivery === 'resume' ? t('Fortgesetzt', 'Continued') : t('Gesendet', 'Sent'), clear);
    }
  }

  // ------------------------------------------------------------ render

  function render() {
    var link = (view && view.link) || { state: 'connecting' };
    var bridgeName = (view && view.bridge && view.bridge.name) || link.bridge || '';
    var label = word(LINK, link.state) || '';
    if (mode === 'retry' && !view) label = t('Claude-Dienst im Auto startet …', 'Claude service in the car is starting …');
    els.link.textContent = label + (link.state === 'online' && bridgeName ? ' · ' + bridgeName : '');
    els.link.setAttribute('class', 'link ' + (link.state || ''));
    var away = Boolean(view && view.bridge && view.bridge.away);
    els.away.setAttribute('aria-pressed', away ? 'true' : 'false');
    els.away.textContent = away ? t('Unterwegs-Modus an', 'Away mode on') : t('Unterwegs-Modus aus', 'Away mode off');
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
    var parts = [h('h2', {}, t('Mit dem Mac koppeln', 'Pair with the Mac'))];
    if (link.state === 'rejected' && link.error) parts.push(h('p', { class: 'bad' }, link.error));
    var install = h('li', {}, t('Auf dem Mac einmal das Claude-Code-Plugin installieren, im Terminal:', 'On the Mac, install the Claude Code plugin once, in the terminal:'),
      h('code', { class: 'cmd' }, 'claude plugin marketplace add appenetic/cs-extensions'),
      h('code', { class: 'cmd' }, 'claude plugin install coilshift@appenetic'),
      h('span', { class: 'hint' }, t('Oder in Claude Code dieselben Befehle mit /plugin statt claude plugin.', 'Or in Claude Code, the same commands with /plugin instead of claude plugin.')));
    var phone = [
      h('li', {}, t('In Claude Code ', 'In Claude Code, run '), h('code', {}, '/coilshift:pair'),
        t(' ohne Code ausführen. Der Kopplungslink landet in der Zwischenablage, per Universal Clipboard auch auf dem iPhone.',
          ' without a code. The pairing link lands in the clipboard, and through Universal Clipboard on the iPhone too.')),
      h('li', {}, t('Diesen QR-Code mit dem Handy scannen und das lokale Zertifikat einmal bestätigen.', 'Scan this QR code with your phone and confirm the local certificate once.')),
      h('li', {}, t('Auf der Handy-Seite den Link einfügen und „Koppeln“ tippen.', 'On the phone page, paste the link and tap “Pair”.'))];
    if (code) {
      parts.push(h('ol', { class: 'steps', id: 'setup-steps' }, install,
        h('li', {}, t('In einer neuen Claude-Code-Sitzung eingeben:', 'In a new Claude Code session, enter:'),
          h('code', { class: 'cmd pair-code', id: 'pairing-code' }, '/coilshift:pair ' + code),
          h('span', { class: 'hint' }, t('Das klappt überall, ohne gemeinsames WLAN und ohne Tailscale: Der Mac schickt die Kopplung über ein Ende-zu-Ende-verschlüsseltes Internet-Relay.',
            'This works anywhere, without a shared Wi-Fi and without Tailscale: the Mac sends the pairing through an end-to-end encrypted internet relay.')))));
      if (pairing.message) parts.push(h('p', { class: 'hint', id: 'pairing-message' }, pairing.message));
      if (addresses.length) {
        parts.push(h('h3', {}, t('Oder mit dem Handy, im selben WLAN oder Tailnet wie das Auto', 'Or with your phone, on the same Wi-Fi or tailnet as the car')));
        parts.push(h.apply(null, ['ol', { class: 'steps' }].concat(phone)));
      }
    } else {
      parts.push(h.apply(null, ['ol', { class: 'steps', id: 'setup-steps' }, install].concat(phone)));
    }
    if (pairing.state === 'open' && addresses.length) {
      var shown = addresses[0];
      for (var i = 0; i < addresses.length; i++) if (addresses[i].url === picks.address) shown = addresses[i];
      parts.push(h('img', { class: 'qr', id: 'pairing-qr', src: shown.qr, alt: t('QR-Code für die Kopplung am Handy', 'QR code for pairing on the phone'), width: '256', height: '256' }));
      var until = new Date(pairing.expires * 1000);
      parts.push(h('p', { class: 'hint', id: 'pairing-url' }, shown.url.split('#')[0] + t(' · gültig bis ', ' · valid until ') + until.getHours() + ':' + ('0' + until.getMinutes()).slice(-2)));
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
      var again = button(t('Neuen QR-Code anzeigen', 'Show a new QR code'), { type: 'button', class: 'primary', id: 'pair-new' }, function () {
        act('/api/pairing', {});
      });
      again.disabled = sending;
      parts.push(again);
    } else if (!code) {
      parts.push(h('p', { class: 'hint' }, pairing.state === 'failed' ? t('Die Kopplungsseite konnte nicht gestartet werden.', 'The pairing page could not be started.')
        : t('QR-Code wird vorbereitet …', 'Preparing the QR code …')));
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
    if (!list.length) items.push(h('p', { class: 'hint' }, t('Noch keine Sitzungen. Sie erscheinen, sobald Claude Code auf dem Mac läuft.', 'No sessions yet. They appear as soon as Claude Code runs on the Mac.')));
    list.forEach(function (x) {
      var item = button('', { type: 'button', class: 'session' + (s && x.id === s.id ? ' on' : '') + (x.pending ? ' asks' : ''), 'aria-label': x.title }, function () {
        selected = x.id;
        focused = true;
        say('');
        render();
      });
      item.append(
        h('span', { class: 'name' }, pulse(x), x.title),
        h('span', { class: 'meta' }, (x.pending ? t('Frage offen', 'Question open') : word(STATUS, x.status)) + ' · ' + word(KIND, x.kind) + ' · ' + ago(x.updated))
      );
      items.push(item);
    });
    if ((view.projects || []).length && mode === 'live') {
      items.push(button(t('+ Neue Sitzung', '+ New session'), { type: 'button', class: 'new', id: 'new-session' }, function () {
        screen = 'new';
        render();
      }));
    }
    if (view.hidden > 0 && mode === 'live') {
      var back = button(view.hidden + t(' ausgeblendet · wieder einblenden', ' hidden · show again'), { type: 'button', class: 'new', id: 'unhide' }, function () {
        act('/api/unhide', {}, function () {
          say(t('Alle Sitzungen wieder eingeblendet.', 'All sessions shown again.'), 'ok');
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
    var hide = button(t('Ausblenden', 'Hide'), { type: 'button', class: 'chip', id: 'hide' }, function () {
      act('/api/hide', { session: s.id }, function () {
        selected = null;
        focused = false;
        say(t('Ausgeblendet. Die Sitzung kommt zurück, sobald dort wieder etwas passiert.', 'Hidden. The session comes back as soon as something happens there.'), 'ok');
      });
    });
    hide.disabled = sending || mode !== 'live';
    els.head.replaceChildren(
      h('div', { class: 'title' },
        h('h2', {}, pulse(s), s.title),
        h('p', { class: 'hint' }, shortPath(s.cwd) + ' · ' + word(KIND, s.kind) + ' · ' + (s.pending ? t('wartet auf dich', 'waiting for you') : word(STATUS, s.status)))),
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
      if (m.role === 'event') {
        rows.unshift(eventRow(m));
        continue;
      }
      if (m.role === 'agent') {
        rows.unshift(agentCard(s, m));
        continue;
      }
      if (m.role === 'assistant' && m.step) {
        // Claude's words on the way, small; the first of a turn says who and when.
        var before = messages[i - 1];
        var first = !before || (before.role !== 'assistant' && before.role !== 'tool' && before.role !== 'agent');
        rows.unshift(h('li', { class: 'message assistant step' }, first ? h('span', { class: 'who' }, word(ROLE, 'assistant') + ' · ' + ago(m.at)) : '', markdown(m.text)));
        continue;
      }
      // The images stand below the text instead of their "[Image #n]".
      var text = m.images ? trim(String(m.text || '').replace(/\[Image #\d+\]/g, '')) : m.text;
      var body = m.role === 'assistant' ? markdown(m.text) : h('span', { class: 'text' }, text);
      var item = h('li', { class: 'message ' + m.role }, h('span', { class: 'who' }, word(ROLE, m.role) + ' · ' + ago(m.at)), body);
      if (m.role === 'user' && m.images > 0) item.append(pictures(s.id, m));
      if (m.role === 'assistant' && m.text) item.append(speaker(s.id, m));
      rows.unshift(item);
    }
    if (!rows.length) rows.push(h('li', { class: 'hint' }, t('Noch kein Verlauf.', 'No history yet.')));
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
            answer(s, p, { answers: answers }, t('Antwort gesendet', 'Answer sent'));
          });
          b.disabled = !live;
          if (o.description) b.append(h('small', {}, o.description));
          row.append(b);
        });
        card.append(row);
      });
      if (collect) {
        var all = button(t('Antworten senden', 'Send answers'), { type: 'button', class: 'primary', id: 'send-picks' }, function () {
          var answers = {};
          questions.forEach(function (q, qi) {
            var labels = [];
            (q.options || []).forEach(function (o, oi) {
              if (picks[qi + ':' + oi]) labels.push(o.label);
            });
            if (labels.length) answers[q.question] = labels.join(', ');
          });
          if (!Object.keys(answers).length) return say(t('Bitte zuerst eine Antwort wählen.', 'Please choose an answer first.'), 'bad');
          answer(s, p, { answers: answers }, t('Antworten gesendet', 'Answers sent'));
        });
        all.disabled = !live;
        card.append(all);
      }
    } else if (p.kind === 'permission') {
      card.append(h('h3', {}, t('Freigabe: ', 'Approval: ') + (p.tool || t('Werkzeug', 'tool'))), h('pre', { class: 'detail-text' }, p.detail || p.text));
      var allow = button(t('Erlauben', 'Allow'), { type: 'button', class: 'primary', id: 'allow' }, function () {
        answer(s, p, { decision: 'allow' }, t('Freigegeben', 'Allowed'));
      });
      var deny = button(t('Ablehnen', 'Deny'), { type: 'button', class: 'danger', id: 'deny' }, function () {
        answer(s, p, { decision: 'deny' }, t('Abgelehnt', 'Denied'));
      });
      allow.disabled = !live;
      deny.disabled = !live;
      card.append(h('div', { class: 'options' }, allow, deny));
    } else {
      card.append(h('h3', {}, t('Claude wartet auf dich', 'Claude is waiting for you')), markdown(p.text));
    }
    if (p.kind !== 'input' && s.delivery !== 'hook') {
      card.append(h('p', { class: 'hint' }, t('Diese Frage ist im Terminal auf dem Mac offen. Mit eingeschaltetem Unterwegs-Modus warten künftige Fragen auf deine Antwort im Auto.',
        'This question is open in the terminal on the Mac. With away mode on, future questions wait for your answer in the car.')));
    } else {
      card.append(h('p', { class: 'hint' }, t('Antwort per Tippen, über das Mikrofon der Tastatur oder mit der Sprachtaste: „Claude, …“',
        'Answer by tapping, with the keyboard\'s microphone or with the voice button: “Claude, …”')));
    }
    return card;
  }

  var HINTS = {
    inbox: ['Geht direkt in die laufende Sitzung. Diktieren über das Mikrofon der Tesla-Tastatur.',
      'Goes straight into the running session. Dictate with the microphone of the Tesla keyboard.'],
    hook: ['Beantwortet die offene Frage mit eigenem Text.', 'Answers the open question with your own words.'],
    resume: ['Setzt die beendete Sitzung auf dem Mac im Hintergrund fort.', 'Continues the ended session on the Mac in the background.'],
    fork: ['Diese Sitzung läuft ohne Postfach, weil sie vor dem Plugin gestartet wurde. Deine Nachricht startet eine Kopie im Hintergrund, die mit dem bisherigen Verlauf weiterarbeitet.',
      'This session runs without an inbox because it started before the plugin. Your message starts a copy in the background that carries on with the history so far.']
  };

  function renderComposer(s) {
    var canSend = mode === 'live' && !sending && s.delivery !== '';
    if (els.composer.getAttribute('data-session') !== s.id) {
      els.composer.value = drafts[s.id] || '';
      els.composer.setAttribute('data-session', s.id);
    }
    els.composer.setAttribute('placeholder', s.delivery === 'resume' || s.delivery === 'fork'
      ? t('Woran soll Claude weiterarbeiten?', 'What should Claude carry on with?') : t('Nachricht an Claude …', 'Message to Claude …'));
    els.composer.disabled = !canSend;
    els.send.disabled = !canSend;
    els.send.textContent = sending ? t('Wird gesendet …', 'Sending …') : s.delivery === 'resume' ? t('Fortsetzen', 'Continue')
      : s.delivery === 'fork' ? t('Als Kopie senden', 'Send as a copy') : t('Senden', 'Send');
    els.composerHint.textContent = canSend
      ? word(HINTS, HINTS[s.delivery] ? s.delivery : 'inbox')
      : mode !== 'live'
        ? t('Verbindung zum Claude-Dienst im Auto wird aufgebaut …', 'Connecting to the Claude service in the car …')
        : t('Diese Sitzung nimmt gerade keinen Text an. Sie läuft vermutlich ohne das CoilShift-Plugin.', 'This session takes no text right now. It probably runs without the CoilShift plugin.');
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
      [t('Verbindung', 'Connection'), (word(LINK, link.state) || '–') + (link.error ? ' · ' + link.error : '')],
      ['Bridge', view && view.bridge ? (view.bridge.name || '') + ' · ' + (view.bridge.version || '') : '–'],
      [t('Weg zum Mac', 'Route to the Mac'), !diag.route ? '–' : diag.route.indexOf('relay') === 0
        ? t('Internet-Relay', 'Internet relay') + (diag.route.length > 6 ? ' · ' + diag.route.slice(6) : '') : t('direkt · ', 'direct · ') + diag.route],
      [t('Web-Port', 'Web port'), diag['web.listen'] ? diag['web.listen'] + (diag['web.port'] ? ' · ' + diag['web.port'] + ' (' + (diag['web.mode'] || '') + ')' : '')
        : t('noch keine Meldung', 'no report yet')],
      [t('Web-Dienst', 'Web service'), (diag['web.service'] || '–') + (diag['web.bind'] ? ' · Namespace ' + diag['web.bind'] : '')],
      [t('Karte über der Navi', 'Card over the map'), diag.card || t('noch keine Meldung', 'no report yet')],
      [t('Sprachtaste', 'Voice button'), diag.voice || t('noch keine Meldung', 'no report yet')],
      [t('Letzte Sprachantwort', 'Last voice answer'), diag['voice.last'] || '–'],
      [t('Musik beim Vorlesen', 'Music while reading aloud'), diag.media || '–'],
      [t('Fahrstufe', 'Gear'), (view && view.gear) || '–']
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

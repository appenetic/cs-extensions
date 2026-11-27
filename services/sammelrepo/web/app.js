// Copy buttons, a confirmation before a source is removed, live progress
// while sources load, and the chart's tooltips. Texts go in as textContent.
(function () {
  'use strict';

  function select(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.getAttribute('data-copy'));
      if (!el) return;
      var label = btn.textContent;
      var done = function () {
        btn.textContent = 'Kopiert';
        setTimeout(function () { btn.textContent = label; }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(el.textContent.trim()).then(done, function () { select(el); });
      } else {
        select(el);
      }
    });
  });

  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // While sources load, show their progress and reload once they are done,
  // unless an address is being typed.
  if (document.body.hasAttribute('data-busy')) {
    var input = document.getElementById('url');
    var typing = function () { return input && (input.value !== '' || document.activeElement === input); };
    var poll = function () {
      fetch('/admin/zustand', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (z) {
          var busy = z.busy || {};
          document.querySelectorAll('[data-progress]').forEach(function (el) {
            var text = busy[el.getAttribute('data-progress')];
            if (text) el.textContent = text + ' …';
          });
          if (Object.keys(busy).length === 0 && !typing()) {
            location.reload();
            return;
          }
          setTimeout(poll, 1500);
        }, function () { setTimeout(poll, 5000); });
    };
    setTimeout(poll, 1500);
  }

  var tip = document.querySelector('.tip');
  if (tip) {
    var show = function (el) {
      tip.textContent = el.getAttribute('data-tip');
      tip.hidden = false;
      var r = el.getBoundingClientRect();
      var bar = el.firstElementChild ? el.firstElementChild.getBoundingClientRect() : r;
      var t = tip.getBoundingClientRect();
      var width = document.documentElement.clientWidth;
      var x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), width - t.width - 8);
      var y = Math.min(bar.top, r.bottom - 4) - t.height - 8;
      if (y < 8) y = r.bottom + 8;
      tip.style.left = (x + window.scrollX) + 'px';
      tip.style.top = (y + window.scrollY) + 'px';
    };
    var hide = function () { tip.hidden = true; };
    document.querySelectorAll('[data-tip]').forEach(function (el) {
      el.addEventListener('pointerenter', function () { show(el); });
      el.addEventListener('pointerleave', hide);
      el.addEventListener('focus', function () { show(el); });
      el.addEventListener('blur', hide);
    });
    window.addEventListener('scroll', hide, { passive: true });
  }
})();

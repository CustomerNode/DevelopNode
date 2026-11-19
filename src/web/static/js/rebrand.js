/* VibeNode is now DevelopNode: the one-time notice that renames this
   computer's shortcuts, their icons and the project's name.
   The server finds what still carries the old name (GET /api/rebrand,
   src/web/rebrand.py) and renames it (POST /api/rebrand/apply).  The notice
   shows only while something is left and "Not now" was over a day ago.
   Design: the new name leads, the list folds under one line.
   Styles: css/rebrand.css. */
(function () {
  'use strict';

  var MARK = '<svg viewBox="0 0 181 142" aria-hidden="true"><path d="M0 0h36.5l70 71-70 71H0l70-71z"/>'
           + '<circle cx="154.5" cy="116" r="26"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function close(ov) {
    ov.classList.remove('show');
    setTimeout(function () { ov.remove(); }, 250);
  }

  function show(st) {
    if (document.getElementById('vn-rebrand')) return;
    var items = st.items || [];
    var ov = document.createElement('div');
    ov.className = 'overlay vn-rebrand';
    ov.id = 'vn-rebrand';
    ov.innerHTML =
      '<div class="pm-card" role="dialog" aria-labelledby="vn-rebrand-name">'
      + '<div class="vrb-lk" id="vn-rebrand-name">' + MARK + esc(st.new) + '<span class="vrb-tm">&trade;</span></div>'
      + '<div class="vrb-was">New name, same app. Formerly ' + esc(st.old) + '.</div>'
      + '<div class="vrb-acts"><button class="btn primary" data-go>Update this computer</button>'
      + '<button class="btn" data-later>Not now</button></div>'
      + '<details class="vrb-list"><summary>What changes on this computer (' + items.length + ')</summary><ul>'
      + items.map(function (it, i) {
          return '<li data-i="' + i + '"><span class="vrb-st"></span><span>' + esc(it.label)
            + ' &rarr; <b>' + esc(it.becomes) + '</b></span></li>';
        }).join('')
      + '</ul></details>'
      + '<p class="vrb-done" hidden></p>'
      + '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });

    var go = ov.querySelector('[data-go]');
    var later = ov.querySelector('[data-later]');
    var done = ov.querySelector('.vrb-done');

    // Not now is kept in this browser only: a test browser another session
    // drives against the live app must not hide the notice from the person.
    later.onclick = function () {
      try { localStorage.setItem(LATER_KEY, String(Date.now())); } catch (e) {}
      close(ov);
    };
    // Escape only closes it for this page.
    ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(ov); });

    go.onclick = function () {
      go.disabled = true; later.hidden = true;
      go.textContent = 'Updating…';
      ov.querySelector('details').open = true;
      fetch('/api/rebrand/apply', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var rows = ov.querySelectorAll('.vrb-list li');
          (res.results || []).forEach(function (r, i) {
            var st = rows[i] && rows[i].querySelector('.vrb-st');
            if (st) { st.textContent = r.ok ? '✓' : '×'; st.className = 'vrb-st ' + (r.ok ? 'ok' : 'fail'); }
          });
          var failed = (res.results || []).filter(function (r) { return !r.ok; }).length;
          done.hidden = false;
          done.textContent = failed
            ? failed + ' could not be renamed; the rest are done.'
            : 'Done. Your phone gets the new icon by itself; an iPhone shows you how the next time you open it.';
          go.textContent = 'Close'; go.disabled = false;
          go.onclick = function () { close(ov); };
          if (typeof loadProjects === 'function') { try { loadProjects(); } catch (e) {} }
        })
        .catch(function () {
          done.hidden = false;
          done.textContent = 'Could not reach the app to rename. Try again in a moment.';
          go.textContent = 'Try again'; go.disabled = false; later.hidden = false;
        });
    };
    go.focus();
  }

  var LATER_KEY = 'vnRebrandLater';
  function putOff() {
    try { return Date.now() - (+localStorage.getItem(LATER_KEY) || 0) < 24 * 3600 * 1000; } catch (e) { return false; }
  }

  function check() {
    if (putOff()) return;
    fetch('/api/rebrand')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) { if (st && st.show && (st.items || []).length) show(st); })
      .catch(function () {});
  }

  /* The phone's home-screen icon.  Android installs refresh their icon from
     the manifest by themselves.  An iPhone keeps the picture it took when the
     icon was added and has no Share button inside a home-screen app, so the
     steps are shown there, once, with the one thing it cannot do itself
     (copy this address) as a button. */
  var PHONE_KEY = 'vnPhoneIconShown';
  var SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5v10h14V11h-1"/></svg>';
  function phoneIcon() {
    if (navigator.standalone !== true || document.getElementById('vn-rebrand')) return;
    try { if (localStorage.getItem(PHONE_KEY)) return; } catch (e) { return; }
    var url = location.origin + '/';
    var ov = document.createElement('div');
    ov.className = 'overlay vn-rebrand vrb-phone';
    ov.id = 'vn-rebrand';
    ov.innerHTML =
      '<div class="pm-card" role="dialog" aria-labelledby="vn-rebrand-name">'
      + '<img class="vrb-icon" src="/static/developnode.png" alt="">'
      + '<div class="vrb-h" id="vn-rebrand-name">New icon for your home screen</div>'
      + '<ol class="vrb-steps">'
      + '<li><button class="btn primary" data-copy>Copy this app’s address</button></li>'
      + '<li>Paste it into Safari, tap ' + SHARE + ' then <b>Add to Home Screen</b>.</li>'
      + '<li>Press and hold this old icon, then <b>Remove App</b>.</li>'
      + '</ol>'
      + '<button class="btn" data-ok>Got it</button>'
      + '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    var copy = ov.querySelector('[data-copy]');
    copy.onclick = function () {
      var ok = function () { copy.textContent = 'Copied ✓'; };
      if (typeof vnCopyText === 'function') { try { vnCopyText(url); ok(); return; } catch (e) {} }
      try { navigator.clipboard.writeText(url).then(ok, function () { copy.textContent = url; }); }
      catch (e) { copy.textContent = url; }
    };
    ov.querySelector('[data-ok]').onclick = function () {
      try { localStorage.setItem(PHONE_KEY, String(Date.now())); } catch (e) {}
      close(ov);
    };
  }

  // A tab that got this file late (through last-card.js) has no stylesheet for it yet.
  if (!document.querySelector('link[href*="css/rebrand.css"]')) {
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/static/css/rebrand.css?v=' + Date.now();
    document.head.appendChild(l);
  }
  window.VNRebrand = { check: check, show: show, phoneIcon: phoneIcon };
  // Ask again when the tab comes back into view (at most once a minute), so a
  // tab left open sees the notice without a reload once it is due.
  var lastAsk = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || Date.now() - lastAsk < 60000) return;
    lastAsk = Date.now(); check();
  });
  // After the app has drawn, so the notice never fights the loading screen.
  function first() { check(); setTimeout(phoneIcon, 400); }
  if (document.readyState === 'complete') setTimeout(first, 2500);
  else window.addEventListener('load', function () { setTimeout(first, 2500); });
})();

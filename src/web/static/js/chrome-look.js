// Sidebar and top bar look (css/chrome-looks.css).  ?chrome=<look> shows a
// look for this page only and is never saved, so a framed preview never
// changes the look of the app the person is using; localStorage vnChromeLook
// is the saved choice.  Loaded in <head> so the look paints with the page.
(function () {
  var LOOKS = { family: 1, text: 1, hairline: 1, lit: 1 };
  var root = document.documentElement;
  function apply(v) {
    if (LOOKS[v]) root.setAttribute('data-chrome', v);
    else root.removeAttribute('data-chrome');
  }
  var q = null, saved = null;
  try { q = new URLSearchParams(location.search).get('chrome'); } catch (e) {}
  try { saved = localStorage.getItem('vnChromeLook'); } catch (e) {}
  apply(q !== null ? q : saved);
  // The Decide popup switches looks by asking the framed app to change its
  // own address (last-card.js _switchInPlace): no reload, no blank frame.
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'vn:set-address') return;
    var u;
    try { u = new URL(e.data.url, location.href); } catch (_e) { return; }
    if (u.pathname !== location.pathname) return;
    apply(u.searchParams.get('chrome'));
    try { history.replaceState(history.state, '', u.pathname + u.search + location.hash); } catch (_e) {}
    if (e.source) e.source.postMessage({ type: 'vn:set-address:ok' }, e.origin);
  });
  window.VNChromeLook = { apply: apply, looks: Object.keys(LOOKS) };
})();

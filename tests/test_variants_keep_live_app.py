"""Switching choices in the Decide popup never boots the live app again.

A variants page may frame the live app and add each option's styles to it.
Two things made the app's splash screen play on every switch of choice:

- The popup built a new frame of the page for each choice, even when every
  choice is a section of the same page.  Now it keeps the loaded page and only
  changes which section shows (``_switchOwnPage`` in last-card.js), Now
  included, and never hides the page's shared ``[data-keep]`` frame.
- The page booted one copy of the app per option (a frame in each section, or
  one made when its section showed).  ``live_app_reboot_problem``
  (src/engine/handoff_rules.py) sends such a decision back: the page keeps
  ONE copy, marked data-keep, and swaps only the option's styles in it.

Rules run in Python; the popup runs the real last-card.js in headless
Chromium over a local HTTP server (skips without Playwright).
"""
import http.server
import json
import shutil
import threading
from functools import partial
from pathlib import Path

import pytest

from engine import handoff_rules as hr
from engine import smart_termination as st
from tests._browser import shared_browser_scope

ROOT = Path(__file__).resolve().parents[1]
LAST_CARD = ROOT / "src" / "web" / "static" / "js" / "last-card.js"
CSS = ROOT / "src" / "web" / "static" / "css" / "last-card.css"

PER_SECTION = """<!doctype html><body>
<section data-option="now" id="now"><iframe data-v="now"></iframe></section>
<section data-option="A" id="a"><iframe data-v="A"></iframe></section>
<section data-option="B" id="b"><iframe data-v="B"></iframe></section>
<script>document.querySelectorAll('iframe').forEach(f => { f.src = '/?sample=1'; });</script></body>"""

MADE_PER_OPTION = """<!doctype html><body>
<section data-option="now" id="now"></section><section data-option="A" id="a"></section>
<section data-option="B" id="b"></section>
<script>function show(sec) { sec.innerHTML = ''; const f = document.createElement('iframe');
f.src = '/'; sec.appendChild(f); }</script></body>"""

KEPT = """<!doctype html><body>
<section data-option="now" id="now"></section><section data-option="A" id="a"></section>
<section data-option="B" id="b"></section>
<script>const app = document.createElement('iframe'); app.dataset.keep = '1'; app.src = '/';
document.body.appendChild(app);</script></body>"""

SHARED = """<!doctype html><body>
<section data-option="now" id="now"></section><section data-option="A" id="a"></section>
<section data-option="B" id="b"></section>
<div id="stage"><iframe id="app" src="/"></iframe></div></body>"""

NO_APP = """<!doctype html><body>
<section data-option="now" id="now"><div class="row">Sample row</div></section>
<section data-option="A" id="a"><div class="row big">Sample row</div></section>
<section data-option="B" id="b"><div class="row bold">Sample row</div></section></body>"""


def _card(page="opts.html"):
    replies = [{"key": k, "label": f"Sample look {k}", "reply": f"go {k}",
                "screens": [{"label": k, "url": f"/static/scratch/{page}#{k.lower()}", "device": "web"}]}
               for k in "AB"]
    replies[1]["recommended"] = True
    return {"type": "needs_you", "title": "Sample rows", "headline": "Two sample looks for the rows",
            "needs": {"kind": "decision", "ask": "Which sample look?", "why": "x",
                      "look": [{"label": "Looks", "kind": "link", "url": f"/static/scratch/{page}"}],
                      "replies": replies}}


@pytest.fixture
def scratch(tmp_path, monkeypatch):
    monkeypatch.setattr(hr, "_SCRATCH_DIR", tmp_path)
    return tmp_path


@pytest.mark.parametrize("page", [PER_SECTION, MADE_PER_OPTION])
def test_a_page_booting_the_app_per_option_is_sent_back(scratch, page):
    (scratch / "opts.html").write_text(page)
    p = hr.live_app_reboot_problem(_card())
    assert p and "splash" in p and "data-keep" in p
    assert any("splash" in x for x in hr.format_problems(_card()))


@pytest.mark.parametrize("page", [KEPT, SHARED, NO_APP])
def test_one_shared_copy_or_no_app_passes(scratch, page):
    (scratch / "opts.html").write_text(page)
    assert hr.live_app_reboot_problem(_card()) is None


def test_only_decisions_are_judged(scratch):
    (scratch / "opts.html").write_text(PER_SECTION)
    c = _card()
    c["needs"]["kind"] = "none"
    assert hr.live_app_reboot_problem(c) is None


def test_sessions_are_told_to_keep_one_copy():
    for text in (st.INSTRUCTIONS, hr.INSTRUCTIONS):
        assert "data-keep" in text
    assert "splash" in st.INSTRUCTIONS


# ── The popup, in a real browser ─────────────────────────────────────────

POPUP_PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>try { top.__loads = (top.__loads || 0) + 1; } catch (e) {}</script>
<section data-option="now" id="now">sample now</section>
<section data-option="A" id="a">sample a</section>
<section data-option="B" id="b">sample b</section>
<div id="app" data-keep>shared sample app</div>
</body></html>"""


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


@pytest.fixture
def served(tmp_path):
    (tmp_path / "static" / "scratch").mkdir(parents=True)
    (tmp_path / "static" / "scratch" / "opts.html").write_text(POPUP_PAGE, encoding="utf-8")
    shutil.copy(LAST_CARD, tmp_path / "last-card.js")
    shutil.copy(CSS, tmp_path / "last-card.css")
    c = _card()
    (tmp_path / "card.html").write_text(f"""<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/last-card.css"></head>
<body><div id="live-log"><div class="msg asst"><div class="msg-body"><div class="vn-card-ph" data-card='{json.dumps(c).replace("'", "&#39;")}'></div></div></div></div>
<script>var liveSessionId='s1', sessionKinds={{s1:'idle'}}; window.__sent=[];
window._liveSubmitDirect=(sid,text)=>{{ window.__sent.push([sid,text]); }};</script>
<script src="/last-card.js"></script>
<script>VNLastCard.renderIn(document.getElementById('live-log'));</script></body></html>""", encoding="utf-8")
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(tmp_path))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


SHOWN = """() => {
  const f = document.querySelector('.lm-dz .pane:not(.leaving) iframe');
  const d = f && f.contentDocument;
  if (!d || !d.body) return null;
  const vis = [...d.querySelectorAll('section')].filter(s => getComputedStyle(s).display !== 'none').map(s => s.id);
  return { vis, keep: getComputedStyle(d.getElementById('app')).display !== 'none', loads: window.__loads || 0 };
}"""


def test_switching_choices_keeps_the_one_loaded_page(browser, served):
    page = browser.new_page(viewport={"width": 1200, "height": 800})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        page.goto(served + "/card.html", wait_until="load")
        page.wait_for_function("document.querySelectorAll('.lm.skim').length === 1")
        page.locator(".lm-decide").click()
        page.wait_for_selector(".lm-dz")
        # opens on the recommended choice
        page.wait_for_function(f"(() => {{ const s = ({SHOWN})(); return s && s.vis.length === 1 && s.vis[0] === 'b'; }})()")
        tabs = page.locator(".lm-dz .tab")
        for j, want in ((0, "now"), (1, "a"), (2, "b"), (0, "now")):
            tabs.nth(j).click()
            page.wait_for_function(f"(() => {{ const s = ({SHOWN})(); return s && s.vis.length === 1 && s.vis[0] === '{want}'; }})()")
            s = page.evaluate(f"({SHOWN})()")
            assert s["keep"], "the shared frame was hidden"
        # Now, A, B and back: the page (and the app it frames) loaded once
        assert page.evaluate("window.__loads") == 1
        assert not errors, errors
    finally:
        page.close()

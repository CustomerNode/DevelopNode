"""A hidden sessions panel must always be easy to bring back (desktop).

The desktop layout has no collapse arrow or expand button. The
divider between the panel and the main area does both jobs: drag it to resize,
drag it past the minimum to hide the panel, and when the panel is hidden the
divider becomes a strip at the left edge that reopens it.

A faint strip is close to invisible in light theme and reads as a missing
panel, so the strip is a 16px tinted strip with a chevron and a "Show sessions
panel" tooltip.
The other tests pin every way in and out of the hidden state (click, double-
click, drag, reload) so a redesign of the divider cannot strand the panel.

The page is built from the real ``style.css`` plus the real divider block from
``toolbar.js`` and the real ``toggleSidebar()`` from ``app.js``, cut out of those
files by marker, so a regression in any of them fails here.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests._browser import shared_browser_scope

# Every test builds its own page, so a parallel run may split this file
# across workers (see tests/_xdist_schedule.py).
XDIST_SPLITTABLE = True

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "web" / "static"

DIVIDER_MARKER = "/* ---- Sidebar resize / hide (desktop) ----"


def _braced_block(src: str, start: int) -> str:
    """Text from ``start`` through the brace that closes the first ``{`` after it."""
    depth, i = 0, src.index("{", start)
    while i < len(src):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
        i += 1
    raise AssertionError("unbalanced braces")


def _divider_js() -> str:
    """The divider IIFE from toolbar.js: marker comment through its ``})();``."""
    src = (STATIC / "js" / "toolbar.js").read_text(encoding="utf-8")
    assert DIVIDER_MARKER in src, "divider block marker is gone from toolbar.js"
    start = src.index(DIVIDER_MARKER)
    end = src.index("})();", start) + len("})();")
    return src[start:end]


def _toggle_sidebar_js() -> str:
    src = (STATIC / "js" / "app.js").read_text(encoding="utf-8")
    assert "function toggleSidebar()" in src, "toggleSidebar() is gone from app.js"
    # The key and the desktop test it uses sit right above the function.
    start = src.index("const _SIDEBAR_HIDDEN_KEY")
    return src[start : src.index("function toggleSidebar()")] + _braced_block(src, src.index("function toggleSidebar()"))


def _page_html(collapsed: bool) -> str:
    style = (STATIC / "style.css").read_text(encoding="utf-8")
    return f"""<!doctype html>
<html data-theme="light"><head><meta charset="utf-8"><style>{style}</style></head>
<body>
<button class="sidebar-expand-btn" id="btn-sidebar-expand">&gt;</button>
<div class="layout" style="height:100vh">
  <div class="sidebar{' collapsed' if collapsed else ''}"><div class="sidebar-header">Sessions</div></div>
  <div class="resize-handle" id="resize-handle"></div>
  <div class="main" id="main-panel"></div>
</div>
<script>
localStorage.setItem('sidebarHiddenDesktop', {'"1"' if collapsed else '""'});
{_toggle_sidebar_js()}
{_divider_js()}
function state() {{
  const s = document.querySelector('.sidebar'), h = document.getElementById('resize-handle');
  return {{collapsed: s.classList.contains('collapsed'),
           width: s.getBoundingClientRect().width,
           handleWidth: h.getBoundingClientRect().width,
           title: h.title}};
}}
</script></body></html>"""


@pytest.fixture(scope="module")
def browser():
    # This worker's shared browser (tests/_browser.py); contexts this file
    # opens are closed when it is done.
    with shared_browser_scope() as b:
        yield b


@pytest.fixture
def page(browser):
    def _open(collapsed: bool, width: int = 1440):
        # Served from a fake origin, not set_content(): toggleSidebar() writes
        # localStorage, which Chromium denies on about:blank.
        pg = browser.new_page(viewport={"width": width, "height": 900})
        html = _page_html(collapsed)
        pg.route("http://vibenode.test/", lambda r: r.fulfill(body=html, content_type="text/html"))
        pg.goto("http://vibenode.test/")
        return pg

    pages = []

    def factory(collapsed: bool, width: int = 1440):
        pg = _open(collapsed, width)
        pages.append(pg)
        return pg

    yield factory
    for pg in pages:
        pg.close()


@pytest.mark.slow
def test_hidden_strip_is_visible_and_says_what_it_does(page):
    """The hidden panel shows a round, labelled button on its edge, not a sliver."""
    pg = page(collapsed=True)
    st = pg.evaluate("state()")
    assert st["collapsed"] and st["width"] == 0
    button = pg.evaluate(
        """() => { const cs = getComputedStyle(document.getElementById('resize-handle'), '::after');
                   return {w: parseFloat(cs.width), h: parseFloat(cs.height), r: cs.borderRadius}; }"""
    )
    assert button["w"] >= 24 and button["h"] >= 24, f"the round button is {button}, too small to find"
    assert st["handleWidth"] >= 6, "the hidden panel's edge is too thin to drag"
    assert "Show sessions panel" in st["title"], f"strip tooltip is {st['title']!r}"
    chevron = pg.evaluate(
        """() => { const cs = getComputedStyle(document.getElementById('resize-handle'), '::before');
                   return {opacity: parseFloat(cs.opacity), mask: cs.maskImage || cs.webkitMaskImage}; }"""
    )
    assert chevron["opacity"] == 1, "chevron on the hidden strip is faded"
    assert chevron["mask"] and chevron["mask"] != "none", "hidden strip lost its chevron"


@pytest.mark.slow
def test_single_click_on_hidden_strip_opens_panel(page):
    pg = page(collapsed=True)
    pg.click("#resize-handle")
    st = pg.evaluate("state()")
    assert not st["collapsed"] and st["width"] > 100
    assert "double-click to hide" in st["title"]


@pytest.mark.slow
def test_double_click_on_hidden_strip_leaves_panel_open(page):
    """Users double-click a divider out of habit; that must not leave it hidden."""
    pg = page(collapsed=True)
    pg.dblclick("#resize-handle")
    pg.wait_for_timeout(100)
    st = pg.evaluate("state()")
    assert not st["collapsed"], "double-clicking the hidden strip re-hid the panel"
    assert st["width"] > 100


@pytest.mark.slow
def test_double_click_on_open_divider_hides_panel(page):
    pg = page(collapsed=False)
    pg.dblclick("#resize-handle")
    st = pg.evaluate("state()")
    assert st["collapsed"], "double-click on the open divider no longer hides the panel"
    assert "Show sessions panel" in st["title"]


def test_open_divider_lights_up_only_when_reached(page):
    """The open panel's edge shows no mark at rest and an accent line on hover."""
    pg = page(collapsed=False)
    rest = pg.evaluate(
        """() => { const h = document.getElementById('resize-handle');
                   return {before: getComputedStyle(h, '::before').display, bg: getComputedStyle(h).backgroundColor}; }"""
    )
    assert rest["before"] == "none", "a knob or grip is drawn on the open divider again"
    assert rest["bg"] in ("rgba(0, 0, 0, 0)", "transparent"), f"the divider shows a line at rest: {rest}"
    box = pg.locator("#resize-handle").bounding_box()
    pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    pg.wait_for_timeout(400)
    hov = pg.evaluate(
        """() => { const h = document.getElementById('resize-handle');
                   const a = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
                   const p = document.createElement('i'); p.style.color = a; document.body.appendChild(p);
                   const want = getComputedStyle(p).color; p.remove();
                   return {bg: getComputedStyle(h).backgroundColor, want}; }"""
    )
    assert hov["bg"] == hov["want"], f"the divider does not light up when the pointer reaches it: {hov}"


@pytest.mark.slow
def test_drag_shut_then_drag_back_open(page):
    pg = page(collapsed=False)
    box = pg.locator("#resize-handle").bounding_box()
    y = box["y"] + 200
    pg.mouse.move(box["x"] + box["width"] / 2, y)
    pg.mouse.down()
    pg.mouse.move(40, y, steps=10)
    pg.mouse.up()
    assert pg.evaluate("state()")["collapsed"], "dragging past the minimum no longer hides"

    pg.mouse.move(4, y)
    pg.mouse.down()
    pg.mouse.move(300, y, steps=10)
    pg.mouse.up()
    st = pg.evaluate("state()")
    assert not st["collapsed"] and st["width"] > 100, "dragging the strip out no longer reopens"


@pytest.mark.slow
def test_drag_shut_then_click_reopens_at_the_width_it_had(page):
    """Dragging shut passes through the 180px minimum; the panel must not reopen there."""
    pg = page(collapsed=False)
    box = pg.locator("#resize-handle").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + 200
    pg.mouse.move(x, y)
    pg.mouse.down()
    pg.mouse.move(x + 100, y, steps=5)
    pg.mouse.up()
    wide = pg.evaluate("state()")["width"]
    assert pg.evaluate("localStorage.getItem('sidebarWidthDesktop')") == str(wide)

    box = pg.locator("#resize-handle").bounding_box()
    x = box["x"] + box["width"] / 2
    pg.mouse.move(x, y)
    pg.mouse.down()
    pg.mouse.move(10, y, steps=15)
    pg.mouse.up()
    assert pg.evaluate("state()")["collapsed"]
    pg.click("#resize-handle")
    st = pg.evaluate("state()")
    assert not st["collapsed"] and st["width"] == wide, "the panel reopened at another width"


@pytest.mark.slow
def test_hidden_state_survives_reload_and_strip_still_reopens(page):
    """Collapse persists via localStorage; the strip must still work after a reload."""
    pg = page(collapsed=False)
    pg.dblclick("#resize-handle")
    assert pg.evaluate("localStorage.getItem('sidebarHiddenDesktop')") == "1"
    pg.close()
    pg2 = page(collapsed=True)  # what app.js's restore-on-load produces
    pg2.click("#resize-handle")
    assert not pg2.evaluate("state()")["collapsed"]


def test_the_phone_layout_never_saves_a_hidden_desktop_panel(page):
    """The phone drawer closes through toggleSidebar() each time a session opens.

    Saving that under the desktop's key hid the desktop panel on its next load
    whenever the same browser had been at phone width (a narrow window, a
    phone-size preview frame of the app)."""
    pg = page(collapsed=False, width=390)
    pg.evaluate("localStorage.removeItem('sidebarHiddenDesktop')")
    pg.evaluate("toggleSidebar()")
    assert pg.evaluate("state()")["collapsed"], "the phone drawer no longer closes"
    assert pg.evaluate("localStorage.getItem('sidebarHiddenDesktop')") is None, (
        "closing the phone drawer saved a hidden panel for the desktop"
    )


def test_restore_on_load_reads_only_the_desktop_key():
    """The old key held values the phone layout wrote; the restore must not read it."""
    src = (STATIC / "js" / "app.js").read_text(encoding="utf-8")
    restore = src[src.index("// Restore on load (desktop only"):]
    restore = restore[: restore.index("}") + 1]
    assert "_sidebarDesktop()" in restore and "_SIDEBAR_HIDDEN_KEY" in restore
    assert "sidebarCollapsed" not in src, "the old key, written by the phone layout, is read again"


def test_the_panel_scrollbar_shows_only_on_hover():
    """The session list's scrollbar is see-through until the pointer is over the panel."""
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".sidebar :is(.session-list, #workforce-grid) { scrollbar-color: transparent transparent; }" in css
    assert ".sidebar:hover :is(.session-list, #workforce-grid) { scrollbar-color: var(--scrollbar) transparent; }" in css

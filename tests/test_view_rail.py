"""The view button on the rail: one button that opens every place to go.

``src/web/static/js/view-rail.js`` adds one button among the rail's bottom
icons, under the cloud and above Settings.  It always shows the same icon; a press opens a menu in the look of the
Settings menu: Sessions, Tasks, Where agents are and, under a line, Needs you.
The view on screen has a tick; it is the way back to Sessions from the agents
view, which is drawn over the app.

The real page in headless Chromium (tests/_fake_app.py); only the network is
faked.  Skips without Playwright.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from tests._browser import shared_browser_scope

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "web" / "static"

ON = "() => [...document.querySelectorAll('#vn-views [data-view].on')].map(b => b.dataset.view)"
OPEN = "() => document.getElementById('vn-views').classList.contains('open')"


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _app(browser, **kw):
    from tests._fake_app import FakeApp, fake_sessions, init_script
    return FakeApp(browser, fake_sessions(3), init=init_script("sessions", "grid"),
                   extra_routes={"/api/agent-fleet": lambda _r: (200, {"at": 1, "hours": 72, "projects": []}),
                                 "/api/feed": lambda _r: (200, {"project": "p", "items": []})}, **kw)


def _pick(page, view):
    page.locator("#vn-views .vv-trg").click()
    page.locator(f"#vn-views [data-view={view}]").click()


def test_the_page_loads_the_button_once_and_it_takes_the_themes_colours():
    html = (ROOT / "src" / "web" / "templates" / "index.html").read_text("utf-8")
    assert html.count("versioned_static('js/view-rail.js')") == 1
    assert html.count("versioned_static('css/view-rail.css')") == 1
    css = (STATIC / "css" / "view-rail.css").read_text("utf-8")
    assert "var(--bg-dropdown)" in css and "var(--border-light)" in css     # the Settings menu's own look
    assert "var(--accent)" not in css                                       # no accent fills, bars or glows


def test_one_button_sits_under_the_cloud_and_above_settings(browser):
    app = _app(browser)
    try:
        page = app.page
        assert page.locator("#vn-views .vv-trg").count() == 1
        btn, gear, logo = (page.locator(s).bounding_box() for s in ("#vn-views .vv-trg", "header .hdr-sys", "header .hdr-brand"))
        assert (round(btn["width"]), round(btn["height"])) == (32, 32)
        assert abs(btn["x"] - gear["x"]) < 4 and logo["y"] + 200 < btn["y"] < gear["y"]     # in the bottom group, above Settings
        # Directly above Settings; any cloud button that is showing sits above it.
        between = app.eval("""([top, bottom]) => [...document.querySelectorAll('header > *')].filter(e => e.getClientRects().length
            && e.getBoundingClientRect().y > top && e.getBoundingClientRect().y < bottom).length""", [btn["y"], gear["y"]])
        assert between == 0
        app.eval("() => { document.getElementById('btn-git-publish').style.display = 'flex'; }")
        cloud, btn = page.locator("#btn-git-publish").bounding_box(), page.locator("#vn-views .vv-trg").bounding_box()
        assert cloud["y"] < btn["y"] < gear["y"]
        assert page.locator("#btn-doom").count() == 0 and page.locator("#btn-agent-fleet").count() == 0   # both are inside it
        assert not app.eval(OPEN)
    finally:
        app.close()


def test_a_press_opens_the_menu_with_needs_you_under_a_line(browser):
    app = _app(browser)
    try:
        page = app.page
        icon = app.eval("() => document.querySelector('#vn-views .vv-trg').innerHTML")
        page.locator("#vn-views .vv-trg").click()
        assert app.eval(OPEN)
        assert app.eval("() => [...document.querySelectorAll('#vn-views .vv-menu > *')].map(e => e.dataset.view || 'line')") == ["sessions", "tasks", "fleet", "line", "doom"]
        assert app.eval("() => [...document.querySelectorAll('#vn-views [data-view] span')].map(s => s.textContent)") == ["Sessions", "Tasks", "Where agents are", "Needs you"]
        assert app.eval(ON) == ["sessions"]
        menu, btn = page.locator("#vn-views .vv-menu").bounding_box(), page.locator("#vn-views .vv-trg").bounding_box()
        assert menu["x"] > btn["x"] + btn["width"] and menu["y"] + menu["height"] <= btn["y"] + btn["height"] + 1   # beside it, growing upward
        page.keyboard.press("Escape")
        assert not app.eval(OPEN)
        page.locator("#vn-views .vv-trg").click()
        page.mouse.click(900, 300)                                          # a press elsewhere closes it
        assert not app.eval(OPEN)
        _pick(page, "tasks")
        assert app.eval("() => document.querySelector('#vn-views .vv-trg').innerHTML") == icon    # the icon never changes
    finally:
        app.close()


def test_tasks_opens_the_task_columns_and_sessions_comes_back(browser):
    app = _app(browser)
    try:
        page = app.page
        _pick(page, "tasks")
        page.wait_for_function("typeof viewMode !== 'undefined' && viewMode === 'kanban' && location.hash === '#kanban'")   # the fade has finished
        assert not app.eval(OPEN)                                           # picking closes the menu
        assert app.eval("() => window.VNFeed ? VNFeed.mode() : 'tasks'") == "tasks"      # the columns, not the feed
        page.locator("#vn-views .vv-trg").click()
        assert app.eval(ON) == ["tasks"]
        page.locator("#vn-views [data-view=sessions]").click()
        page.wait_for_function("viewMode === 'sessions' && !location.hash.startsWith('#kanban')")   # the fade has finished
        # A view the menu does not hold ticks nothing.
        app.eval("() => { setViewMode('workplace'); }")
        page.wait_for_function("viewMode === 'workplace'")
        page.locator("#vn-views .vv-trg").click()
        assert app.eval(ON) == []
    finally:
        app.close()


def test_sessions_sticks_when_the_task_board_finishes_loading_late(browser):
    """A board load that ends after the person left must not pull the app back to it."""
    app = _app(browser)
    try:
        page = app.page
        _pick(page, "tasks")
        page.wait_for_function("viewMode === 'kanban' && location.hash === '#kanban'")     # the switch has finished, fade included
        _pick(page, "sessions")
        page.wait_for_function("viewMode === 'sessions' && !location.hash.startsWith('#kanban')")
        app.eval("async () => { history.replaceState(null, '', location.pathname + location.search); await _initKanbanImpl(); }")
        assert not app.eval("() => location.hash").startswith("#kanban")
        assert app.eval("() => viewMode") == "sessions"
        # While the view fades the address still says #kanban; a load ending then must not follow it back.
        app.eval("async () => { history.replaceState(null, '', '#kanban'); await _initKanbanImpl(); }")
        assert app.eval("() => viewMode") == "sessions"
    finally:
        app.close()


def test_the_agents_view_opens_from_it_and_the_menu_opens_over_it(browser):
    app = _app(browser)
    try:
        page = app.page
        _pick(page, "fleet")
        page.wait_for_selector("#agent-fleet")
        page.locator("#vn-views .vv-trg").click()
        assert app.eval(ON) == ["fleet"]
        box = page.locator("#vn-views [data-view=sessions]").bounding_box()
        top = app.eval("([x, y]) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('#vn-views')); }",
                       [box["x"] + box["width"] - 8, box["y"] + box["height"] / 2])
        assert top                                                          # not hidden behind the agents view
        page.locator("#vn-views [data-view=sessions]").click()
        page.wait_for_selector("#agent-fleet", state="detached")
        page.locator("#vn-views .vv-trg").click()
        assert app.eval(ON) == ["sessions"]
    finally:
        app.close()


def test_needs_you_opens_and_closes_its_panel_beside_the_view(browser):
    app = _app(browser)
    try:
        page = app.page
        _pick(page, "doom")
        page.wait_for_function("VNDoom.state().state === 'open'")
        page.locator("#vn-views .vv-trg").click()
        assert app.eval(ON) == ["sessions", "doom"]                         # a panel beside the view, not a view
        page.locator("#vn-views [data-view=doom]").click()
        page.wait_for_function("VNDoom.state().state === 'closed'")
        # It closes the agents view, which would cover it.
        _pick(page, "fleet")
        page.wait_for_selector("#agent-fleet")
        _pick(page, "doom")
        page.wait_for_selector("#agent-fleet", state="detached")
        assert app.eval("() => VNDoom.state().state") == "open"
    finally:
        app.close()


def test_a_phone_has_no_view_button(browser):
    app = _app(browser, viewport={"width": 390, "height": 844}, context={"is_mobile": True, "has_touch": True})
    try:
        assert not app.page.locator("#vn-views").is_visible()
        items = app.eval("() => [...document.querySelectorAll('.vn-more-pop [data-item]')].map(b => b.dataset.item)")
        assert "fleet" in items and "doom" in items                         # both stay in the More menu there
    finally:
        app.close()

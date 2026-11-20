"""Right-clicking a project in the Projects window opens a menu with Rename
and Delete, drawn like the session right-click menu, and Rename opens the
same Rename Project prompt as the row's pencil.

Browser: ``_projectContextMenu`` in ``src/web/static/js/app.js``, run in the
real page in headless Chromium with only the network faked.
"""
import json

import pytest

from tests._browser import shared_browser_scope
from tests._fake_app import FakeApp, fake_sessions


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b

OPEN = """async () => {
  openProjectOverlay();
  for (let i = 0; i < 100 && !document.querySelector(
      '#project-list .project-item[data-encoded]:not(.project-item-all):not(.project-item-add)'); i++)
    await new Promise(r => setTimeout(r, 20));
}"""

RIGHT_CLICK = """() => {
  const row = document.querySelector(
    '#project-list .project-item[data-encoded]:not(.project-item-all):not(.project-item-add)');
  const r = row.getBoundingClientRect();
  const ev = new MouseEvent('contextmenu', {bubbles: true, cancelable: true,
    clientX: r.left + 20, clientY: r.top + 10, button: 2});
  row.dispatchEvent(ev);
  const menu = document.querySelector('.project-ctx-menu');
  return {
    prevented: ev.defaultPrevented,
    labels: menu ? [...menu.querySelectorAll('.ws-ctx-item .vn-ctx-lbl')].map(e => e.textContent) : null,
    sessionLook: !!(menu && menu.classList.contains('session-ctx-menu')),
    aboveOverlay: menu ? +getComputedStyle(menu).zIndex >
      +getComputedStyle(document.getElementById('project-overlay')).zIndex : false,
    icons: menu ? menu.querySelectorAll('.ws-ctx-item svg').length : 0,
  };
}"""


@pytest.mark.slow
def test_right_click_on_a_project_offers_rename_and_delete(browser):
    renames = []

    def rename(req):
        renames.append(json.loads(req.post_data or "{}"))
        return 200, {"ok": True}

    app = FakeApp(browser, fake_sessions(2), extra_routes={"/api/rename-project": rename})
    try:
        app.page.evaluate(OPEN)
        got = app.page.evaluate(RIGHT_CLICK)
        assert got["prevented"], "the browser's own menu must not open"
        assert got["labels"] == ["Rename", "Delete"]
        assert got["sessionLook"] and got["aboveOverlay"] and got["icons"] == 2

        # Rename opens the Rename Project prompt and saves the new name.
        app.page.click(".project-ctx-menu .ws-ctx-item[data-action='rename']")
        assert app.eval("() => !document.querySelector('.project-ctx-menu')")
        app.page.wait_for_selector("text=Rename Project", timeout=5000)
        field = app.page.locator("input[placeholder='Project name']")
        field.fill("Renamed Project")
        field.press("Enter")
        for _ in range(50):
            if renames:
                break
            app.page.wait_for_timeout(50)
        assert renames and renames[0]["name"] == "Renamed Project"
        assert not app.errors, app.errors
    finally:
        app.close()


@pytest.mark.slow
def test_a_click_elsewhere_closes_the_project_menu(browser):
    app = FakeApp(browser, fake_sessions(2))
    try:
        app.page.evaluate(OPEN)
        app.page.evaluate(RIGHT_CLICK)
        assert app.eval("() => !!document.querySelector('.project-ctx-menu')")
        app.page.mouse.click(5, 5)
        assert app.eval("() => !document.querySelector('.project-ctx-menu')")
        assert not app.errors, app.errors
    finally:
        app.close()

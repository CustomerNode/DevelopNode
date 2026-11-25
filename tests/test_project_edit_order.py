"""Edit order in the Projects window: the header button turns on drag
handles, dragging a project saves the whole order, a tap does not open a
project while editing, and Sort by name goes back to name order.

Browser: ``_wireProjectReorder`` / ``_saveProjectOrder`` in
``src/web/static/js/app.js``, run in the real page in headless Chromium with
only the network faked.  Server side: ``tests/test_project_order.py``.
"""
import json

import pytest

from tests._browser import shared_browser_scope
from tests._fake_app import FakeApp, fake_sessions, PROJECT, CWD

ROWS = '#project-list .project-item[data-encoded]:not(.project-item-all):not(.project-item-add)'


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _app(browser):
    projects = [
        {"encoded": "proj-alpha", "display": "C:\test\alpha", "custom_name": "Alpha", "session_count": 1},
        {"encoded": "proj-beta", "display": "C:\test\beta", "custom_name": "Beta", "session_count": 1},
        {"encoded": PROJECT, "display": CWD, "custom_name": "Gamma", "session_count": 2},
    ]
    state = {"order": [], "posts": []}

    def listing(req):
        if not state["order"]:
            return 200, projects
        rank = {e: i for i, e in enumerate(state["order"])}
        return 200, [dict(p, ordered=True) for p in sorted(projects, key=lambda p: rank[p["encoded"]])]

    def save(req):
        order = json.loads(req.post_data or "{}").get("order")
        state["posts"].append(order)
        state["order"] = order
        return 200, {"ok": True, "order": order}

    app = FakeApp(browser, fake_sessions(2),
                  extra_routes={"/api/project-order": save, "/api/projects": listing})
    return app, state


def _names(app):
    return app.eval(f"() => [...document.querySelectorAll('{ROWS} .project-item-name span')].map(e => e.textContent)")


def _wait(app, cond, ms=3000):
    for _ in range(ms // 50):
        if cond():
            return True
        app.page.wait_for_timeout(50)
    return cond()


@pytest.mark.slow
def test_drag_a_project_saves_the_order_and_sort_by_name_resets(browser):
    app, state = _app(browser)
    try:
        app.page.evaluate("() => openProjectOverlay()")
        assert _wait(app, lambda: len(_names(app)) == 3)
        assert _names(app) == ["Alpha", "Beta", "Gamma"]
        assert app.eval("() => document.querySelector('.project-sortline').textContent") == "Sorted by name"
        # Handles appear only in Edit order.
        assert app.eval("() => getComputedStyle(document.querySelector('.project-grip')).display") == "none"
        app.page.click(".project-edit-order")
        assert app.eval("() => document.querySelector('.project-edit-order').textContent") == "Done"
        assert app.eval("() => getComputedStyle(document.querySelector('.project-grip')).display") != "none"

        # A tap while editing opens nothing.
        app.eval("() => { window.__picked = null; window.selectProjectFromOverlay = e => { window.__picked = e; }; }")
        app.page.locator(ROWS).nth(0).click()
        assert app.eval("() => window.__picked") is None

        # Drag Gamma (last) to the top with the mouse.
        rows = app.page.locator(ROWS)
        a, t = rows.nth(2).bounding_box(), rows.nth(0).bounding_box()
        x = a["x"] + 120
        app.page.mouse.move(x, a["y"] + a["height"] / 2)
        app.page.mouse.down()
        app.page.mouse.move(x, a["y"] + a["height"] / 2 - 10, steps=3)
        app.page.mouse.move(x, t["y"] + 2, steps=12)
        app.page.mouse.up()
        assert _wait(app, lambda: state["posts"] == [[PROJECT, "proj-alpha", "proj-beta"]]), state["posts"]
        assert _wait(app, lambda: _names(app) == ["Gamma", "Alpha", "Beta"]), _names(app)
        assert "Your order" in app.eval("() => document.querySelector('.project-sortline').textContent")

        # Sort by name sends an empty order and the list goes back to A to Z.
        app.page.click(".project-sort-reset")
        assert _wait(app, lambda: state["posts"][-1] == [])
        assert _wait(app, lambda: _names(app) == ["Alpha", "Beta", "Gamma"]), _names(app)

        # Done leaves Edit order; a tap opens a project again.
        app.page.click(".project-edit-order")
        app.page.locator(ROWS).nth(0).click()
        assert app.eval("() => window.__picked") == "proj-alpha"
        assert not app.errors, app.errors
    finally:
        app.close()

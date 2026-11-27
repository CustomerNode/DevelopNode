"""Needs-you reel: every session that needs you, one per screen, in a panel out of the right.

``src/web/static/js/doomscroll.js`` is opened from the view button on the left
rail.  It slides a panel out from the page's right edge and pushes the app
left to make room, so nothing is covered.  Each screen is one session that
needs you (``GET /api/feed``): its picture, its words, and its summary card's own
answer buttons as pills that press the real card's buttons; full screen
covers everything, minimize leaves a tab with the count on the right edge, the
X closes it.  On a phone it is an entry in the ••• menu above Settings.

The real page in headless Chromium (tests/_fake_app.py); only the network is
faked.  Skips without Playwright.
"""
from __future__ import annotations

import pytest

from tests._browser import shared_browser_scope


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _card(title):
    return {"type": "needs_you", "title": title, "headline": title + " needs a pick.", "answer": "Short.",
            "explained": "Plain words.", "full_answer": "Full.",
            "needs": {"kind": "approve", "ask": "Ship it?", "replies": [
                {"key": "A", "label": "First", "reply": "First"}, {"key": "B", "label": "Second", "reply": "Second"}]}}


def _feed(_request):
    items = [{"session_id": f"s{i}", "name": f"Session {i}", "title": f"Thing {i}", "headline": "", "line": "",
              "verb": "decide", "group": "needs", "label": "Decide", "ts": 1791370000 - i, "card": _card(f"Thing {i}")}
             for i in range(3)]
    items.append({"session_id": "w", "name": "Busy", "title": "Busy", "verb": "working", "group": "working",
                  "label": "Working", "ts": 1, "card": None})
    return 200, {"project": "p", "items": items}


RECT = """() => { const p = document.getElementById('vn-doom').getBoundingClientRect(),
  l = document.querySelector('.layout').getBoundingClientRect();
  return {left: Math.round(p.left), right: Math.round(p.right), layout: Math.round(l.right), w: innerWidth,
          state: VNDoom.state().state, size: VNDoom.state().size}; }"""


def _app(browser, **kw):
    from tests._fake_app import FakeApp, fake_sessions, init_script
    return FakeApp(browser, fake_sessions(4), init=init_script("sessions", "grid"),
                   extra_routes={"/api/feed": _feed}, **kw)


def _open_reel(page):
    """Needs you opens from the view button on the rail (view-rail.js)."""
    page.locator("#vn-views .vv-trg").click()
    page.locator("#vn-views [data-view=doom]").click()


def test_it_opens_from_the_view_button_and_the_panel_pushes_the_app_left(browser):
    app = _app(browser)
    try:
        page = app.page
        assert page.locator("#btn-doom").count() == 0          # no icon of its own: it is in the view button's menu

        closed = app.eval(RECT)
        assert closed["left"] >= closed["w"] and closed["layout"] == closed["w"]   # off the right edge

        _open_reel(page)
        page.wait_for_function("document.querySelectorAll('#vn-doom .vd-slide').length === 3")
        app.animations_done()
        r = app.eval(RECT)
        assert r["right"] == r["w"] and r["left"] < r["w"]
        assert r["layout"] == r["left"]          # the app ends where the panel begins: pushed, not covered
        assert page.locator("#vn-doom .vd-slide .lm").count() == 3   # each session's real summary card, drawn for its buttons
        assert page.locator("#vn-doom .vd-slide .vr-title").first.inner_text() == "Thing 0"
        assert page.locator("#vn-doom .vd-slide").first.locator(".vr-art").count() == 1   # no picture: the drawn tile
        assert "Busy" not in page.locator("#vn-doom").inner_text()   # only what needs you

        page.locator(".vd-head [data-act=size]").click()
        app.animations_done()
        r = app.eval(RECT)
        assert (r["left"], r["right"], r["size"]) == (0, r["w"], "full")

        page.locator(".vd-head [data-act=size]").click()
        page.locator(".vd-head [data-act=min]").click()
        app.animations_done()
        r = app.eval(RECT)
        assert r["state"] == "min" and r["layout"] == r["w"]
        assert page.locator(".vn-doom-tab.in b").inner_text() == "3"

        page.locator(".vn-doom-tab").click()
        assert app.eval(RECT)["state"] == "open"
        page.locator(".vd-head [data-act=close]").click()
        app.animations_done()
        r = app.eval(RECT)
        assert r["state"] == "closed" and r["layout"] == r["w"]
        assert not app.errors, app.errors
    finally:
        app.close()


def test_a_card_reply_in_the_panel_answers_that_session(browser):
    app = _app(browser)
    try:
        page = app.page
        app.eval("() => { window.__sent = []; window._liveSubmitDirect = (sid, text) => window.__sent.push([sid, text]); }")
        _open_reel(page)
        page.wait_for_function("document.querySelectorAll('#vn-doom .vd-slide').length === 3")
        pill = page.locator("#vn-doom .vd-slide").nth(1).locator(".vr-pill").first
        assert pill.inner_text().strip() == "First"
        pill.click()
        sent = app.eval("() => window.__sent")
        assert sent and sent[0][0] == "s1"
    finally:
        app.close()


def test_phone_menu_has_needs_you_above_settings(browser):
    app = _app(browser, viewport={"width": 390, "height": 844}, context={"is_mobile": True, "has_touch": True})
    try:
        items = app.eval("() => [...document.querySelectorAll('.vn-more-pop [data-item]')].map(b => b.dataset.item)")
        assert items.index("doom") == items.index("settings") - 1
        app.eval("() => VNDoom.open()")
        app.page.wait_for_function("document.querySelectorAll('#vn-doom .vd-slide').length === 3")
        app.animations_done()
        r = app.eval(RECT)
        assert (r["left"], r["right"]) == (0, r["w"])
    finally:
        app.close()


def test_a_link_opens_the_app_with_the_panel_out(browser):
    from tests._fake_app import FakeApp, fake_sessions, init_script
    app = FakeApp(browser, fake_sessions(4), init=init_script("sessions", "grid"), path="/?needsyou=1",
                  extra_routes={"/api/feed": _feed})
    try:
        app.page.wait_for_function("window.VNDoom && VNDoom.state().state === 'open'")
        app.page.wait_for_function("document.querySelectorAll('#vn-doom .vd-slide').length === 3")
    finally:
        app.close()


def test_a_summary_picture_sits_across_the_top(browser):
    def feed(_r):
        c = _card("Pictured")
        c["links"] = [{"label": "After", "kind": "image", "url": "/static/svg/pickaxe.svg"}]
        return 200, {"project": "p", "items": [{"session_id": "p1", "name": "P", "title": "Pictured", "verb": "review",
                                                 "group": "needs", "label": "Review", "ts": 1, "card": c}]}
    from tests._fake_app import FakeApp, fake_sessions, init_script
    app = FakeApp(browser, fake_sessions(4), init=init_script("sessions", "grid"), extra_routes={"/api/feed": feed})
    try:
        _open_reel(app.page)
        app.page.wait_for_function("document.querySelector('#vn-doom .vr-hero img')")
        assert app.eval("() => document.querySelector('#vn-doom .vr-hero img').getAttribute('src')") == "/static/svg/pickaxe.svg"
        top = app.eval("() => [document.querySelector('#vn-doom .vr-hero').getBoundingClientRect().top, document.querySelector('#vn-doom .vr-title').getBoundingClientRect().top]")
        assert top[0] < top[1]   # the picture above the words
    finally:
        app.close()

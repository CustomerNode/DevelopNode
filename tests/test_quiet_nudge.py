"""The all-quiet bubble beside the Publish button (static/js/quiet-nudge.js).

Against the real page (tests/_fake_app.py), the repo being the open project:
  * nothing shows when the page opens already quiet;
  * busy -> quiet shows it only after quiet has held for the hold time;
  * going busy again hides it, and a second crossing shows it again;
  * "Don't show this again" turns it off on this device and asks the server
    to keep the preference;
  * no changes to publish: nothing shows;
  * the preference reaches and leaves the server's config route.
"""
from __future__ import annotations

import pytest

from tests._browser import shared_browser_scope
from tests._fake_app import PROJECT, FakeApp, fake_sessions

BUBBLE = "() => document.querySelectorAll('.vn-quiet-nudge').length"


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _app(browser, git):
    puts = []

    def config(req):
        if req.method == "PUT":
            puts.append(req.post_data_json if hasattr(req, "post_data_json") else req.post_data)
        return 200, {}

    app = FakeApp(browser, fake_sessions(5), clock=True, extra_routes={
        "/api/repo-project": lambda r: (200, {"ok": True, "project": PROJECT, "root": "C:\\test\\proj"}),
        "/api/git-status": lambda r: (200, git),
        "/api/kanban/config": config,
    })
    app.puts = puts
    # Stand-in statuses: the test decides whether the project is busy.
    app.eval("""() => { window._qnMode = 'quiet';
        SessionVerb.display = () => window._qnMode === 'busy' ? 'working' : 'done';
        window._waitingPolledOnce = true; }""")
    app.eval("() => pollGitStatus()")
    app.advance(100)
    return app


def _mode(app, m):
    app.eval(f"() => {{ window._qnMode = '{m}'; VNQuietNudge.evaluate(); }}")
    app.advance(50)


def test_busy_to_quiet_shows_the_bubble_after_the_hold(browser):
    app = _app(browser, {"ahead": 2, "behind": 0, "uncommitted": False, "has_git": True})
    try:
        _mode(app, "quiet")
        app.advance(6000)
        assert app.eval(BUBBLE) == 0, "opening the app already quiet shows nothing"

        _mode(app, "busy")
        _mode(app, "quiet")
        app.advance(2000)
        assert app.eval(BUBBLE) == 0, "quiet has not held long enough yet"
        app.advance(2500)
        assert app.eval(BUBBLE) == 1
        text = app.eval("() => document.querySelector('.vn-quiet-nudge').textContent")
        assert "All your sessions are quiet" in text and "2 changes not published" in text

        _mode(app, "busy")
        app.advance(400)
        assert app.eval(BUBBLE) == 0, "work starting again takes it away"

        _mode(app, "quiet")
        app.advance(4500)
        assert app.eval(BUBBLE) == 1, "a second crossing shows it again"

        app.eval("() => document.querySelector('.vn-quiet-nudge .qn-stop').click()")
        app.advance(400)
        assert app.eval(BUBBLE) == 0
        assert app.eval("() => localStorage.getItem('vnQuietNudge')") == "off"
        assert app.eval("() => VNQuietNudge.enabled()") is False

        _mode(app, "busy")
        _mode(app, "quiet")
        app.advance(4500)
        assert app.eval(BUBBLE) == 0, "stopped means stopped"
        assert app.errors == []
    finally:
        app.close()


def test_nothing_to_publish_shows_nothing(browser):
    app = _app(browser, {"ahead": 0, "behind": 0, "uncommitted": False, "has_git": True})
    try:
        _mode(app, "busy")
        _mode(app, "quiet")
        app.advance(4500)
        assert app.eval(BUBBLE) == 0
    finally:
        app.close()


def test_the_preference_round_trips_through_the_config_route(tmp_path, monkeypatch):
    from web import create_app
    from web import config as cfg_mod
    store = {}
    monkeypatch.setattr(cfg_mod, "get_kanban_config", lambda: dict(store))
    monkeypatch.setattr(cfg_mod, "save_kanban_config", lambda c: store.update(c))
    client = create_app(testing=True).test_client()
    assert client.get("/api/kanban/config").get_json()["quiet_publish_nudge"] is True
    assert client.put("/api/kanban/config", json={"quiet_publish_nudge": False}).status_code == 200
    assert store["quiet_publish_nudge"] is False
    assert client.get("/api/kanban/config").get_json()["quiet_publish_nudge"] is False

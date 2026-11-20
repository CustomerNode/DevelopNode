"""Up / Down in the message box recall what was sent, like a terminal line.

- Each session has its own list; another session's messages never show up.
- The new-session box has its own list of first prompts, and a first prompt
  also belongs to the session it starts (kept across the CLI's id switch).
- Up acts only with the caret on the first line, Down only on the last;
  walking past the newest puts back what was being typed.
- Messages already in the thread (another device, before this existed) count.

The REAL index.html with every real script in headless Chromium; only the
network is faked (tests/_fake_app.py).
"""

from __future__ import annotations

import pytest

from tests._browser import shared_browser_scope
from tests._fake_app import CWD, FakeApp, fake_sessions, init_script

XDIST_SPLITTABLE = True

VALUE = "() => document.getElementById('live-input-ta').value"


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _app(browser):
    s = fake_sessions(4)
    app = FakeApp(browser, s, init=init_script("sessions", "grid",
                  "localStorage.removeItem('vnComposerHistory');"), clock=True)
    return app, s


def _open(app, sid):
    app.eval("(id) => openInGUI(id)", sid)
    app.advance(400)
    app.page.wait_for_function("() => !!document.getElementById('live-input-ta')", timeout=5000)


def _send(app, text, fn="liveSubmitIdle"):
    app.eval("([t, fn]) => { const ta = document.getElementById('live-input-ta');"
             " ta.value = t; window[fn](); }", [text, fn])
    app.advance(50)
    sid = app.eval("() => liveSessionId")
    app.push("session_state", {"session_id": sid, "state": "idle", "cwd": CWD})
    app.advance(300)
    app.page.wait_for_function("() => !!document.getElementById('live-input-ta')", timeout=5000)


def _key(app, key, times=1):
    app.page.focus("#live-input-ta")
    for _ in range(times):
        app.page.keyboard.press(key)


def test_up_and_down_walk_this_sessions_messages_and_restore_the_draft(browser):
    app, s = _app(browser)
    try:
        _open(app, s[0]["id"])
        _send(app, "first message")
        _send(app, "second message")
        app.eval("() => { const ta = document.getElementById('live-input-ta'); ta.value = 'half typed'; }")
        _key(app, "End")
        _key(app, "ArrowUp")
        assert app.eval(VALUE) == "second message"
        _key(app, "ArrowUp")
        assert app.eval(VALUE) == "first message"
        _key(app, "ArrowUp")           # top of the list: stays
        assert app.eval(VALUE) == "first message"
        _key(app, "ArrowDown")
        assert app.eval(VALUE) == "second message"
        _key(app, "ArrowDown")
        assert app.eval(VALUE) == "half typed"
        assert not app.errors
    finally:
        app.close()


def test_each_session_has_its_own_list(browser):
    app, s = _app(browser)
    try:
        _open(app, s[0]["id"])
        _send(app, "only in session zero")
        _open(app, s[1]["id"])
        app.eval("() => { document.getElementById('live-input-ta').value = ''; }")
        _key(app, "ArrowUp")
        assert app.eval(VALUE) != "only in session zero"
    finally:
        app.close()


def test_up_inside_a_multiline_message_moves_the_caret_not_the_history(browser):
    app, s = _app(browser)
    try:
        _open(app, s[0]["id"])
        _send(app, "earlier")
        app.eval("() => { const ta = document.getElementById('live-input-ta');"
                 " ta.value = 'line one\\nline two'; ta.setSelectionRange(14, 14); }")
        _key(app, "ArrowUp")           # caret on the second line
        assert app.eval(VALUE) == "line one\nline two"
    finally:
        app.close()


def test_a_first_prompt_goes_in_the_new_session_list_and_the_session_it_starts(browser):
    app, s = _app(browser)
    try:
        _open(app, s[0]["id"])
        got = app.eval("""() => {
            const H = window.VNComposerHistory;
            H.record(H.NEW, 'start a thing');
            H.record('temp-1', 'start a thing');
            H.rekey('temp-1', 'real-1');
            return {neu: H.entries(H.NEW, ''), real: H.entries('real-1', 'real-1'),
                    temp: H.entries('temp-1', 'temp-1')};
        }""")
        assert got["neu"] == ["start a thing"]
        assert got["real"] == ["start a thing"]
        assert got["temp"] == []
        # The wrapper records a real submit under both lists.
        app.eval("() => { addNewAgent(); }")
        app.advance(200)
        sid = app.eval("() => liveSessionId")
        app.eval("() => { document.getElementById('live-input-ta').value = 'build me a page';"
                 " _newSessionSubmit(liveSessionId); }")
        app.advance(50)
        got = app.eval("(sid) => { const H = window.VNComposerHistory;"
                       " return [H.entries(H.NEW, ''), H.entries(sid, sid)]; }", sid)
        assert got[0][-1] == "build me a page"
        assert "build me a page" in got[1]
    finally:
        app.close()


def test_messages_already_in_the_thread_are_in_the_list(browser):
    app, s = _app(browser)
    try:
        sid = s[0]["id"]
        _open(app, sid)
        app.eval("""(sid) => {
            const d = document.createElement('div');
            d.className = 'msg user'; d.dataset.sid = sid; d._vnFullText = 'from my phone';
            document.getElementById('live-log').appendChild(d);
        }""", sid)
        app.eval("() => { document.getElementById('live-input-ta').value = ''; }")
        _key(app, "ArrowUp")
        assert app.eval(VALUE) == "from my phone"
    finally:
        app.close()

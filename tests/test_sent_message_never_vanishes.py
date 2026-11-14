"""A sent message stays on screen, with its state, until the thread holds it.

The bubble a send draws used to vanish when the thread was redrawn from the
server's log before the server had written the message into it (a sleeping
session waking, a reconnect, switching sessions and back), so for up to a
minute the message looked lost. Now each send is remembered until the log
holds it, a redraw draws it again, and its footer reads "Sending" until the
server accepts it, then "Delivered" or "Queued".

The real ``index.html`` in headless Chromium; only the network is faked.
"""

from __future__ import annotations

import pytest

from tests._browser import shared_browser_scope


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _log(sid, entries):
    return {"session_id": sid, "total": len(entries), "offset": 0, "has_more": False, "entries": entries}


STATE = """(sid) => {
  const log = document.getElementById('live-log');
  const mine = [...log.querySelectorAll('.msg.user')].filter(m => m.textContent.includes('Rename the export button'));
  const st = log.querySelector('.msg[data-pending-id] .vn-send-state');
  return {count: mine.length, pending: log.querySelectorAll('.msg[data-pending-id]').length,
          state: st ? st.textContent.trim() : ''};
}"""


def _open(app, sid):
    app.eval(f"() => openInGUI('{sid}')")
    app.page.wait_for_function(f"liveSessionId === '{sid}'", timeout=10000)
    app.page.wait_for_timeout(200)


@pytest.mark.slow
def test_a_sent_message_survives_redraws_and_switching_until_the_log_holds_it(browser):
    from tests._fake_app import CWD, FakeApp, fake_sessions, init_script
    s = fake_sessions(2)
    a, b = s[0]["id"], s[1]["id"]
    app = FakeApp(browser, s, init=init_script("sessions", "grid"),
                  viewport={"width": 1200, "height": 900},
                  extra_routes={"/api/session/": lambda r: (200, {"id": a, "display_title": "T", "messages": []})})
    try:
        for sid in (a, b):
            app.push("session_state", {"session_id": sid, "state": "idle", "cwd": CWD})
        _open(app, a)
        before = [{"kind": "user", "text": "Hello"}, {"kind": "asst", "text": "Hi there."}]
        app.push("session_log", _log(a, before))

        app.eval(f"() => _liveSubmitDirect('{a}', 'Rename the export button', {{skipWrongSessionCheck: true}})")
        got = app.eval(STATE, a)
        assert got["count"] == 1 and got["state"].endswith("Sending"), got

        # A redraw from a log that does not hold the message yet keeps it.
        app.push("session_log", _log(a, before))
        got = app.eval(STATE, a)
        assert got["count"] == 1 and got["state"].endswith("Sending"), got

        # The server accepted it.
        app.push("message_ack", {"session_id": a})
        assert app.eval(STATE, a)["state"].endswith("Delivered")

        # Away and back before the session wrote it: still there, still Delivered.
        _open(app, b)
        app.push("session_log", _log(b, [{"kind": "user", "text": "Other"}]))
        _open(app, a)
        app.push("session_log", _log(a, before))
        got = app.eval(STATE, a)
        assert got["count"] == 1 and got["state"].endswith("Delivered"), got

        # The log now holds it: drawn once, as the server's, nothing pending.
        app.push("session_log", _log(a, before + [{"kind": "user", "text": "Rename the export button"}]))
        got = app.eval(STATE, a)
        assert got == {"count": 1, "pending": 0, "state": ""}, got
        assert not app.errors, app.errors
    finally:
        app.close()


@pytest.mark.slow
def test_an_older_identical_message_does_not_count_as_this_one(browser):
    from tests._fake_app import CWD, FakeApp, fake_sessions, init_script
    s = fake_sessions(1)
    a = s[0]["id"]
    app = FakeApp(browser, s, init=init_script("sessions", "grid"),
                  viewport={"width": 1200, "height": 900},
                  extra_routes={"/api/session/": lambda r: (200, {"id": a, "display_title": "T", "messages": []})})
    try:
        app.push("session_state", {"session_id": a, "state": "idle", "cwd": CWD})
        _open(app, a)
        old = [{"kind": "user", "text": "Rename the export button", "timestamp": "2026-01-01T10:00:00Z"},
               {"kind": "asst", "text": "Done."}]
        app.push("session_log", _log(a, old))
        app.eval(f"() => _liveSubmitDirect('{a}', 'Rename the export button', {{skipWrongSessionCheck: true}})")
        app.push("session_log", _log(a, old))
        got = app.eval(STATE, a)
        assert got["count"] == 2 and got["pending"] == 1, got
    finally:
        app.close()

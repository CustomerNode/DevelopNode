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


@pytest.mark.slow
def test_a_message_from_before_the_page_is_never_drawn_again_at_the_bottom(browser):
    """A redraw shows only the newest page of the log. After a long turn the
    message that started it is no longer on that page, and it was drawn again
    at the bottom of the thread, as if it had been sent a second time. Once
    the log has moved past a delivered message, it is history."""
    import time
    from tests._fake_app import CWD, FakeApp, fake_sessions, init_script
    s = fake_sessions(1)
    a = s[0]["id"]
    app = FakeApp(browser, s, init=init_script("sessions", "grid"),
                  viewport={"width": 1200, "height": 900},
                  extra_routes={"/api/session/": lambda r: (200, {"id": a, "display_title": "T", "messages": []})})
    try:
        app.push("session_state", {"session_id": a, "state": "idle", "cwd": CWD})
        _open(app, a)
        app.push("session_log", _log(a, [{"kind": "asst", "text": "Ready."}]))
        app.eval(f"() => _liveSubmitDirect('{a}', 'Rename the export button', {{skipWrongSessionCheck: true}})")
        app.push("message_ack", {"session_id": a})
        assert app.eval(STATE, a)["state"].endswith("Delivered")

        # Ten minutes of work later, the page the thread is redrawn from starts
        # after the message (offset 97 of 197): it is not on it.
        later = time.time() + 600
        page = [{"kind": "tool_use", "name": "Read", "timestamp": later},
                {"kind": "asst", "text": "All done.", "timestamp": later + 5}]
        app.push("session_log", {"session_id": a, "total": 197, "offset": 97, "has_more": True, "entries": page})
        got = app.eval(STATE, a)
        assert got == {"count": 0, "pending": 0, "state": ""}, got
        assert app.eval(f"() => _pendingSendsApi.list('{a}').length") == 0
        assert not app.errors, app.errors
    finally:
        app.close()


@pytest.mark.slow
def test_a_queued_message_stays_while_the_turn_it_waits_behind_runs_on(browser):
    import time
    from tests._fake_app import CWD, FakeApp, fake_sessions, init_script
    s = fake_sessions(1)
    a = s[0]["id"]
    app = FakeApp(browser, s, init=init_script("sessions", "grid"),
                  viewport={"width": 1200, "height": 900},
                  extra_routes={"/api/session/": lambda r: (200, {"id": a, "display_title": "T", "messages": []})})
    try:
        app.push("session_state", {"session_id": a, "state": "idle", "cwd": CWD})
        _open(app, a)
        app.push("session_log", _log(a, [{"kind": "asst", "text": "Ready."}]))
        app.eval(f"() => _liveSubmitDirect('{a}', 'Rename the export button', {{skipWrongSessionCheck: true}})")
        app.push("message_ack", {"session_id": a, "queued": True})
        later = time.time() + 600
        app.push("session_log", {"session_id": a, "total": 197, "offset": 97, "has_more": True,
                                 "entries": [{"kind": "asst", "text": "Still going.", "timestamp": later}]})
        got = app.eval(STATE, a)
        assert got["count"] == 1 and got["state"].endswith("Queued"), got
    finally:
        app.close()


@pytest.mark.slow
def test_a_new_sessions_first_message_shows_at_once_even_while_the_agent_list_loads(browser):
    """Send on a new session waited on the agent list (a scan of the project
    that took seconds) before drawing anything: the box emptied and the
    greeting stayed. The message must show at once, marked Sending."""
    from tests._fake_app import FakeApp, fake_sessions, init_script
    s = fake_sessions(1)
    app = FakeApp(browser, s, init=init_script("sessions", "grid"),
                  viewport={"width": 1200, "height": 900})
    try:
        # The agent list takes 3 s, as on a large project.
        app.eval("""() => { const f = window.fetch; window.fetch = (u, ...r) =>
            String(u).includes('/api/invoke/discover') ? new Promise(ok => setTimeout(() => ok(f(u, ...r)), 3000)) : f(u, ...r);
            _agentCatalogPath = null; _agentCatalogPromise = null; if (typeof _localWfCache !== 'undefined') _localWfCache = null;
            window.FOLDER_SUPERSET = window.FOLDER_SUPERSET || {}; }""")
        app.eval("() => addNewAgent()")
        app.page.wait_for_selector("#live-input-ta", state="attached", timeout=10000)
        sid = app.eval("() => liveSessionId")
        app.eval("""() => { const ta = document.getElementById('live-input-ta'); ta.value = 'Rename the export button';
            _newSessionSubmit(liveSessionId); }""")
        app.page.wait_for_timeout(150)
        got = app.eval(STATE, sid)
        assert got["count"] == 1 and got["state"].endswith("Sending"), got
        assert not app.eval("() => !!document.querySelector('#live-log .empty-state')"), "greeting still on screen"
        # Once the session is started, the server confirms it.
        app.page.wait_for_function("window.__emits.some(e => e[0] === 'start_session')", timeout=10000)
        app.push("session_started", {"session_id": sid})
        got = app.eval(STATE, sid)
        assert got["count"] == 1 and got["state"].endswith("Delivered"), got
        assert not app.errors, app.errors
    finally:
        app.close()

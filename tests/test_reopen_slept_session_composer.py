"""Reopening a session this tab just slept still shows its text box.

A session opened while running is remembered in ``guiOpenSessions``. Once it
sleeps it has no running state and no kind, and ``updateLiveInputBar`` took
that combination for "a new session not sent yet" and left the bar alone, so
reopening the session drew the panel with an empty, 28px text box and no way
to type. Only a session nothing has been sent to may be skipped now
(``live-panel.js``). The real ``index.html`` in headless Chromium.
"""

from __future__ import annotations

import pytest

# At module level: conftest keeps the shared browser open only for files that
# import this name (``uses_shared_browser``).
from tests._browser import shared_browser_scope


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


@pytest.mark.slow
def test_a_slept_session_reopened_in_the_same_tab_has_a_text_box(browser):
    from tests._fake_app import CWD, FakeApp, fake_sessions, init_script
    s = fake_sessions(1)
    sid = s[0]["id"]
    app = FakeApp(browser, s, init=init_script("sessions", "grid"),
                  extra_routes={"/api/session/": lambda r: (200, {"id": sid, "display_title": "T", "messages": []})})
    try:
        app.push("session_state", {"session_id": sid, "state": "stopped", "cwd": CWD})
        # What the tab holds after it opened the session while it ran and
        # then slept it: still in guiOpenSessions, no state, no kind.
        app.eval(f"() => {{ guiOpenAdd('{sid}'); runningIds.delete('{sid}'); delete sessionKinds['{sid}']; }}")
        app.eval(f"() => openInGUI('{sid}')")
        app.page.wait_for_function(f"typeof liveSessionId !== 'undefined' && liveSessionId === '{sid}'", timeout=10000)
        app.page.wait_for_function("!!document.getElementById('live-input-ta')", timeout=5000)
        assert app.eval("() => document.getElementById('live-input-bar').getBoundingClientRect().height") > 60
    finally:
        app.close()


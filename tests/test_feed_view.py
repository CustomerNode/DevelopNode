"""Workflow mode's feed: one line per session, its newest summary card behind
it (``src/web/static/js/feed.js``), on the real page with a faked network.

With Smart termination on, Workflow mode opens on the feed; pressing a line
draws that session's card with the app's own card code, and a reply on it
goes to THAT session, not the one the tab has open; Tasks switches to the
columns and is remembered; a session push reloads the list once.
"""

from __future__ import annotations

import pytest

from tests._browser import shared_browser_scope
from tests._fake_app import PROJECT, FakeApp, fake_sessions, init_script


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _card(**over):
    base = {"type": "done", "title": "Archive sessions", "headline": "Sessions can be archived from the menu.",
            "answer": "Archive sits under Rename.", "explained": "## What\n\n" + "Plain words. " * 30,
            "full_answer": "## Detail\n\nMore.", "zoom": {"big": "Tests", "task": "Archive", "now": "Done"},
            "needs": {"kind": "none", "why": "Done.", "next": "Nothing planned."},
            "what_was_done": "Added Archive.", "checked": "Ran the tests."}
    base.update(over)
    return base


DECIDE = _card(type="needs_you", title="Card number field", headline="Pick how the card-number field reads.",
               needs={"kind": "decision", "ask": "Which card-number field goes on the form?", "why": "w", "next": "n",
                      "replies": [{"key": "A", "label": "One field that formats as you type", "reply": "One field"},
                                  {"key": "B", "label": "Four boxes of four digits", "reply": "Four boxes"}]})
# A To do card: its reply is a button on the card itself (a Decide's replies
# are picked in the Decide popup).
STUCK = _card(type="blocked", title="Staging sign-in", headline="Staging refuses the test account until you reset it.",
              tried=[{"what": "Signed in", "result": "Refused"}, {"what": "Reset it through the admin route", "result": "Needs your token"}],
              needs={"kind": "action", "ask": "Reset the staging test account", "why": "Only you have the token.", "next": "The check runs.",
                     "only_you": "The token is yours.", "steps": [{"text": "Open staging admin and reset the account"}],
                     "replies": [{"key": "A", "label": "I reset it", "reply": "I reset it"}]})


def _item(sid, verb, group, label, title, headline, card, **over):
    it = {"session_id": sid, "name": title, "title": title, "headline": headline, "line": headline, "verb": verb,
          "group": group, "label": label, "eta_minutes": None, "state": None, "hold": None, "ts": 1791370000, "card": card}
    it.update(over)
    return it


ITEMS = [
    _item("s-pick", "decide", "needs", "Decide", "Card number field", "Pick how the card-number field reads.", DECIDE),
    _item("s-stuck", "unblock", "needs", "Unblock", "Staging sign-in", "Staging refuses the test account until you reset it.", STUCK),
    _item("s-done", "review", "needs", "Review", "Archive sessions", "Sessions can be archived from the menu.", _card()),
    _item("s-work", "working", "working", "Working", "Nightly report", "Rebuilding the nightly report.", None, eta_minutes=25, state="working"),
    _item("s-held", "done", "done", "Done", "Login fix", "The login fix is in.", _card(title="Login fix"), hold="done"),
]

WAIT_ROWS = "document.querySelectorAll('#feed-view .vnf-row').length > 0"


def _open(browser, *, items=ITEMS, smart="on", wait_for=WAIT_ROWS, config=None):
    calls = []

    def feed(_req):
        calls.append(1)
        return 200, {"project": PROJECT, "items": items}

    app = FakeApp(browser, fake_sessions(2), clock=True,
                  init=init_script("kanban", extra="localStorage.setItem('vnSmartTermination', %r); localStorage.removeItem('vnWorkflowView');" % smart),
                  extra_routes={"/api/feed": feed,
                                "/api/kanban/board": lambda r: (200, {"columns": [], "tasks": []}),
                                "/api/kanban/config": lambda r: (200, config if config is not None else {"smart_termination": smart == "on"})},
                  wait_for=wait_for)
    app.calls = calls
    return app


def _rows(app):
    return app.eval("[...document.querySelectorAll('#feed-view .vnf-row')].map(r => [r.dataset.sid, "
                    "r.querySelector('.vnf-ttl').textContent, r.querySelector('.vnf-act').textContent, r.closest('.vnf-folded') !== null])")


def test_workflow_opens_on_the_feed_with_lines_in_reading_order(browser):
    app = _open(browser)
    try:
        assert app.eval("getComputedStyle(document.getElementById('feed-view')).display") != "none"
        assert app.eval("document.getElementById('kanban-board').style.display") == "none"
        assert _rows(app) == [["s-pick", "Card number field", "Decide", False],
                              ["s-stuck", "Staging sign-in", "Unblock", False],
                              ["s-done", "Archive sessions", "Review", False],
                              ["s-work", "Nightly report", "Working · 25 min", False],
                              ["s-held", "Login fix", "Done", True]]
        assert app.eval("document.querySelector('#feed-view .vnf-quiet').textContent") == "3 need you1 working"
        # Each line carries the sidebar's own status picture: the Needs-you
        # mark, the Working pickaxe, the Done check; never a dot of its own.
        icons = app.eval("[...document.querySelectorAll('#feed-view .vnf-row')].map(r => { const ic = r.querySelector('.vnf-ic'); "
                         "const svg = ic.querySelector('svg'), img = ic.querySelector('img'); "
                         "return svg ? [...svg.classList].filter(c => c.startsWith('vs-')).join(' ') : img ? img.getAttribute('src') : 'none'; })")
        assert icons == ["vs-ic vs-needs", "vs-ic vs-needs", "vs-ic vs-needs", "/static/svg/pickaxe.svg", "vs-ic vs-done"]
        assert app.eval("document.querySelectorAll('#feed-view .vnf-dot').length") == 0
        # Drawn big enough to read at a glance: 24px, the same for the picture and the pickaxe.
        sizes = app.eval("[...document.querySelectorAll('#feed-view .vnf-ic > *')].map(e => getComputedStyle(e).width)")
        assert sizes and set(sizes) == {"24px"}
        # Done and Standby fold behind one row until it is pressed.
        assert app.eval("document.querySelector('#feed-view .vnf-folded').hidden") is True
        app.page.click("#feed-view [data-fold]")
        assert app.eval("document.querySelector('#feed-view .vnf-folded').hidden") is False
        assert app.eval("document.querySelector('#kanban-view-seg [data-wv=feed]').classList.contains('on')") is True
        assert app.errors == []
    finally:
        app.close()


def test_pressing_a_line_draws_its_card_and_another_line_closes_it(browser):
    app = _open(browser)
    try:
        app.page.click("#feed-view .vnf-row[data-sid='s-done']")
        assert app.eval("document.querySelectorAll('#feed-view .lm.skim').length") == 1
        assert app.eval("document.querySelector('#feed-view .vnf-row.open').dataset.sid") == "s-done"
        assert app.eval("document.querySelector('#feed-view .lm.skim').dataset.sid") == "s-done"
        assert app.eval("document.querySelector('#feed-view .lm.skim .lm-title').textContent") == "Archive sessions"
        # A Done card waits for the person's verdict: the Done / Standby rows show.
        fin = app.eval("(() => { const f = document.querySelector('#feed-view .lm-finish'); return f ? [f.hidden, f.dataset.state] : null; })()")
        assert fin == [False, "verdict"]
        app.page.click("#feed-view .vnf-row[data-sid='s-pick']")
        assert app.eval("document.querySelectorAll('#feed-view .lm.skim').length") == 1
        assert app.eval("document.querySelector('#feed-view .lm.skim .lm-title').textContent") == "Card number field"
        assert app.eval("[...document.querySelectorAll('#feed-view .vnf-row.open')].map(r => r.dataset.sid)") == ["s-pick"]
        # Pressing the open line again closes it.
        app.page.click("#feed-view .vnf-row[data-sid='s-pick']")
        assert app.eval("document.querySelectorAll('#feed-view .lm.skim').length") == 0
        # A working session without a card says so, with the way to its thread.
        app.page.click("#feed-view .vnf-row[data-sid='s-work']")
        assert "Working" in app.eval("document.querySelector('#feed-view .vnf-nocard').textContent")
        assert app.errors == []
    finally:
        app.close()


def test_a_reply_on_an_opened_card_goes_to_that_session(browser):
    app = _open(browser)
    try:
        app.page.click("#feed-view .vnf-row[data-sid='s-stuck']")
        app.page.click("#feed-view .lm-row.reply[data-reply='I reset it']")
        app.page.wait_for_function("window.__emits.some(e => e[0] === 'send_message')", timeout=5000)
        sent = app.eval("window.__emits.filter(e => e[0] === 'send_message').map(e => [e[1].session_id, String(e[1].text).replace(/^⟦VN-NOTE⟧[\\s\\S]*?⟦\\/VN-NOTE⟧\\s*/, '')])")
        assert sent == [["s-stuck", "I reset it"]]
        # The card marks the pick, as it does in the chat.
        assert app.eval("document.querySelector('#feed-view .lm-row.reply.picked').dataset.reply") == "I reset it"
        assert app.errors == []
    finally:
        app.close()


def test_tasks_switches_to_the_columns_and_the_choice_is_kept(browser):
    app = _open(browser)
    try:
        app.page.click("#kanban-view-seg [data-wv=tasks]")
        assert app.eval("document.getElementById('feed-view').style.display") == "none"
        assert app.eval("document.getElementById('kanban-board').style.display") == ""
        assert app.eval("localStorage.getItem('vnWorkflowView')") == "tasks"
        assert app.eval("document.querySelector('#kanban-view-seg [data-wv=tasks]').classList.contains('on')") is True
        app.page.click("#kanban-view-seg [data-wv=feed]")
        assert app.eval("document.getElementById('feed-view').style.display") == ""
        assert app.eval("document.getElementById('kanban-board').style.display") == "none"
        assert app.errors == []
    finally:
        app.close()


def test_a_session_push_reloads_the_feed_once(browser):
    app = _open(browser)
    try:
        n = len(app.calls)
        app.push_many("session_state", [{"session_id": "s-pick", "state": "working", "cwd": ""},
                                        {"session_id": "s-done", "state": "idle", "cwd": ""},
                                        {"session_id": "s-work", "state": "idle", "cwd": ""}])
        app.advance(2500)
        app.page.wait_for_function("document.querySelectorAll('#feed-view .vnf-row').length > 0", timeout=5000)
        assert len(app.calls) == n + 1
        assert app.errors == []
    finally:
        app.close()


def test_with_smart_termination_off_workflow_opens_on_the_tasks(browser):
    app = _open(browser, smart="off", wait_for="typeof viewMode !== 'undefined' && viewMode === 'kanban' && !!window.VNFeed",
                config={"smart_termination": False})
    try:
        app.advance(600)     # past the view fade, which shows the board a moment after entering Workflow
        assert app.eval("VNFeed.mode()") == "tasks"
        assert app.eval("document.getElementById('feed-view').style.display") == "none"
        assert app.eval("document.getElementById('kanban-board').style.display") == ""
        assert app.errors == []
    finally:
        app.close()

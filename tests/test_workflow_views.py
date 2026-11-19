"""Workflow mode's Queue and Agents views on the real page with a faked
network (``src/web/static/js/queue.js``, ``agents-map.js``, the view switch
in ``feed.js``).

The queue lists tasks in their groups with their status read off their
cards; a task opens its parts; Start makes an orchestrator (the session is
started the way the board starts one, then linked to the task); a session
line opens its card.  The agent map draws the project's folders as tiles with
each session on the folder it worked in, and opens an agent to its steps and
its card.  The Workflow sidebar's switch moves between the four views.
"""

from __future__ import annotations

import json

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


def _sess(sid, verb, group, label, title, headline, card=None, **over):
    s = {"session_id": sid, "verb": verb, "group": group, "label": label, "title": title, "headline": headline,
         "eta_minutes": None, "ts": 1791370000, "card": card}
    s.update(over)
    return s


PICK = _sess("s-pick", "decide", "needs", "Decide", "Card number field", "Pick how the card-number field reads.",
             _card(type="needs_you", title="Card number field", headline="Pick how the card-number field reads.",
                   needs={"kind": "decision", "ask": "Which?", "why": "w", "next": "n",
                          "replies": [{"key": "A", "label": "One field that formats as you type", "reply": "One field"}]}))
ORCH = _sess("s-orch", "working", "working", "Working", "Checkout redesign", "Two of five parts are done.", None, eta_minutes=25)

QUEUE = {"project": PROJECT, "tasks": [
    {"id": "t-checkout", "title": "Checkout redesign", "verb": "decide", "group": "needs", "label": "Decide", "old_status": "working", "position": 1,
     "latest": "Pick how the card-number field reads.", "sessions": [ORCH], "children_done": 1, "has_session": True,
     "children": [{"id": "t-pay", "title": "Payment form", "verb": "decide", "group": "needs", "label": "Decide", "old_status": "working", "position": 1,
                   "latest": "Pick how the card-number field reads.", "sessions": [PICK], "children": [], "children_done": 0, "has_session": True},
                  {"id": "t-coupon", "title": "Coupon codes", "verb": "done", "group": "done", "label": "Done", "old_status": "complete", "position": 2,
                   "latest": "", "sessions": [], "children": [], "children_done": 0, "has_session": False}]},
    {"id": "t-nightly", "title": "Nightly report emails", "verb": "working", "group": "working", "label": "Working", "old_status": "working", "position": 2,
     "latest": "Rebuilding the nightly report.", "sessions": [_sess("s-night", "working", "working", "Working", "Nightly report", "Rebuilding the nightly report.", None, eta_minutes=40)],
     "children": [], "children_done": 0, "has_session": True},
    {"id": "t-shopify", "title": "Import from Shopify", "verb": "new", "group": "new", "label": "Not started", "old_status": "not_started", "position": 3,
     "latest": "", "sessions": [], "children": [], "children_done": 0, "has_session": False},
    {"id": "t-old", "title": "Rate limiter on login", "verb": "done", "group": "done", "label": "Done", "old_status": "complete", "position": 4,
     "latest": "", "sessions": [], "children": [], "children_done": 0, "has_session": False},
], "unfiled": [_sess("s-loose", "review", "needs", "Review", "Loose end", "A loose session with a card.", _card(title="Loose end"))]}

AGENTS = {"project": PROJECT, "cwd": "C:\\test\\proj", "tree": [
    {"path": "src", "files": 40}, {"path": "src/web", "files": 25}, {"path": "src/engine", "files": 15}, {"path": "tests", "files": 20}, {"path": ".", "files": 3}],
    "agents": [
        {"session_id": "s-orch", "name": "Checkout redesign", "title": "Checkout redesign", "headline": "Two of five parts are done.", "verb": "working", "group": "working", "label": "Working",
         "live": True, "files": ["src/web/a.py", "src/web/b.py"], "folders": {"src/web": 2}, "last_ts": 1791370000,
         "steps": [{"verb": "Ran", "obj": "Run the tests", "file": None, "ts": 1791370000}, {"verb": "Changed", "obj": "a.py", "file": "src/web/a.py", "ts": 1791369000}],
         "card": _card(type="working", title="Checkout redesign", headline="Two of five parts are done.", needs={"kind": "none", "why": "runs", "next": "merges", "eta_minutes": 25, "stages": ["a", "b"], "stage": "b"})},
        {"session_id": "s-pick", "name": "Payment form", "title": "Card number field", "headline": "Pick how the card-number field reads.", "verb": "decide", "group": "needs", "label": "Decide",
         "live": False, "files": ["tests/test_form.py"], "folders": {"tests": 1}, "last_ts": 1791360000,
         "steps": [{"verb": "Wrote", "obj": "test_form.py", "file": "tests/test_form.py", "ts": 1791360000}], "card": PICK["card"]},
    ]}


def _open(browser, view, *, extra_routes=None, calls=None):
    calls = calls if calls is not None else []

    def rec(name, body):
        def h(req):
            calls.append((name, req.method, req.post_data))
            return 200, body
        return h

    routes = {
        "/api/queue/order": rec("order", {"ok": True}),
        "/api/queue/tasks/": rec("prompt", {"task_id": "t-shopify", "name": "Import from Shopify", "prompt": "Run this task as its orchestrator.", "system_prompt": "## briefing\n\n## You are this task's orchestrator"}),
        "/api/queue": rec("queue", QUEUE),
        "/api/agents": rec("agents", AGENTS),
        "/api/feed": rec("feed", {"project": PROJECT, "items": [PICK]}),
        "/api/kanban/tasks/": rec("link", {"task_id": "t-shopify", "session_id": "x"}),
        "/api/kanban/board": lambda r: (200, {"columns": [], "tasks": []}),
        "/api/kanban/config": lambda r: (200, {"smart_termination": True}),
    }
    routes.update(extra_routes or {})
    app = FakeApp(browser, fake_sessions(2), clock=True,
                  init=init_script("kanban", extra="localStorage.setItem('vnSmartTermination', 'on'); localStorage.setItem('vnWorkflowView', %r);" % view),
                  extra_routes=routes,
                  wait_for="document.querySelectorAll('#%s-view .vnq-task, #%s-view .vna-row, #%s-view .vnf-row').length > 0" % (view, view, view))
    app.calls = calls
    return app


def test_the_queue_lists_tasks_in_groups_with_their_status_and_opens_a_tasks_parts(browser):
    app = _open(browser, "queue")
    try:
        assert app.eval("document.getElementById('queue-view').style.display") == ""
        assert app.eval("document.getElementById('kanban-board').style.display") == "none"
        assert app.eval("document.getElementById('feed-view').style.display") == "none"
        rows = app.eval("[...document.querySelectorAll('#queue-view .vnq-task')].map(r => [r.dataset.task, r.querySelector('.vnf-ttl').textContent, (r.querySelector('.vnf-act') || r.querySelector('.vnq-start')).textContent])")
        assert rows == [["t-checkout", "Checkout redesign", "Decide"], ["t-nightly", "Nightly report emails", "Working"],
                        ["t-shopify", "Import from Shopify", "Start"], ["t-old", "Rate limiter on login", "Done"]]
        assert app.eval("[...document.querySelectorAll('#queue-view .vnq-group')].map(g => g.textContent.trim())")[:4] == ["Needs you", "Working", "Not started", "Done"]
        # The status icon is the sidebar's.
        assert app.eval("[...document.querySelectorAll('#queue-view .vnq-task .vnf-ic svg')].map(s => [...s.classList].join(' '))")[0] == "vs-ic vs-needs"
        # A task opens its parts: its orchestrator and its subsessions, one level.
        app.page.click("#queue-view .vnq-task[data-task='t-checkout']")
        parts = app.eval("[...document.querySelectorAll('#queue-view .vnq-task[data-task=\"t-checkout\"] + .vnq-parts > *')].map(e => e.className.split(' ')[0] + ':' + (e.querySelector('.vnf-ttl') || e).textContent.trim())")
        assert parts[0].startswith("vnq-sess:Checkout redesign") and "orchestrator" in parts[0]
        assert any(p.startswith("vnq-child:Payment form") for p in parts) and any(p.startswith("vnq-child:Coupon codes") for p in parts)
        # A session line opens its card, drawn by the real card code.
        app.page.click("#queue-view .vnq-sess[data-sid='s-pick']")
        assert app.eval("document.querySelector('#queue-view .vnq-sess[data-sid=\"s-pick\"] + .vnf-open .lm.skim .lm-title').textContent") == "Card number field"
        # Unfiled sessions sit at the end.
        assert app.eval("document.querySelector('#queue-view .vnq-sess[data-sid=\"s-loose\"] .vnf-ttl').textContent").startswith("Loose end")
        assert app.errors == []
    finally:
        app.close()


def test_start_makes_the_tasks_orchestrator_and_links_it(browser):
    app = _open(browser, "queue")
    try:
        app.page.click("#queue-view .vnq-start[data-start='t-shopify']")
        app.page.wait_for_function("window.__emits.some(e => e[0] === 'start_session')", timeout=5000)
        emits = app.eval("window.__emits.filter(e => e[0] === 'start_session').map(e => e[1])")
        assert len(emits) == 1
        o = emits[0]
        assert o["prompt"] == "Run this task as its orchestrator." and o["name"] == "Import from Shopify"
        assert "You are this task's orchestrator" in o["system_prompt"] and o["session_id"]
        app.page.wait_for_function("true")
        app.advance(100)
        link = [c for c in app.calls if c[0] == "link" and c[1] == "POST"]
        assert link and json.loads(link[-1][2])["session_id"] == o["session_id"]
        prompt = [c for c in app.calls if c[0] == "prompt"]
        assert prompt and prompt[-1][1] == "GET"
        assert app.errors == []
    finally:
        app.close()


def test_the_agent_map_puts_each_session_on_its_folder_and_opens_its_steps(browser):
    app = _open(browser, "agents")
    try:
        assert app.eval("document.getElementById('agents-view').style.display") == ""
        tiles = app.eval("[...document.querySelectorAll('#agents-view .vna-tile')].map(t => [t.dataset.tile, [...t.querySelectorAll('.vna-dot .vna-nm')].map(d => d.textContent)])")
        assert ["src/web", ["Checkout redesign"]] in tiles and ["tests", ["Card number field"]] in tiles
        assert ["src", []] in tiles
        # The working dot carries the pickaxe; the needs-you dot the sidebar's mark.
        assert app.eval("document.querySelector('#agents-view .vna-dot[data-agent=\"s-orch\"] img').getAttribute('src')") == "/static/svg/pickaxe.svg"
        assert app.eval("[...document.querySelector('#agents-view .vna-dot[data-agent=\"s-pick\"] svg').classList].join(' ')") == "vs-ic vs-needs"
        # Pressing a dot opens the agent's steps and its card.
        app.page.click("#agents-view .vna-dot[data-agent='s-orch']")
        steps = app.eval("[...document.querySelectorAll('#agents-view .vna-row.open + .vna-open .vna-step')].map(s => s.querySelector('.vna-verb').textContent + ' ' + s.querySelector('.vna-obj').textContent)")
        assert steps == ["Ran Run the tests", "Changed a.py"]
        assert app.eval("document.querySelector('#agents-view .vna-row.open + .vna-open .lm.skim .lm-title').textContent") == "Checkout redesign"
        assert app.errors == []
    finally:
        app.close()


def test_the_switch_moves_between_feed_queue_agents_and_tasks(browser):
    app = _open(browser, "feed")
    try:
        def shown():
            return app.eval("['feed-view','queue-view','agents-view','kanban-board'].filter(id => document.getElementById(id).style.display !== 'none')")
        assert shown() == ["feed-view"]
        app.page.click("#kanban-view-seg [data-wv=queue]")
        app.page.wait_for_function("document.querySelectorAll('#queue-view .vnq-task').length > 0", timeout=5000)
        assert shown() == ["queue-view"]
        app.page.click("#kanban-view-seg [data-wv=agents]")
        app.page.wait_for_function("document.querySelectorAll('#agents-view .vna-row').length > 0", timeout=5000)
        assert shown() == ["agents-view"]
        app.page.click("#kanban-view-seg [data-wv=tasks]")
        assert shown() == ["kanban-board"]
        assert app.eval("localStorage.getItem('vnWorkflowView')") == "tasks"
        assert app.eval("[...document.querySelectorAll('#kanban-view-seg [data-wv]')].map(b => b.textContent)") == ["Feed", "Queue", "Agents", "Tasks"]
        assert app.errors == []
    finally:
        app.close()

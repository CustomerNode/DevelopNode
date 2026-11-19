"""The Workflow queue: top-level tasks in the person's order, their status
read off their sessions' summary cards (``src/web/workflow_queue.py``,
``GET /api/queue`` and the orchestrator routes in ``kanban_api``).

Tasks live in the kanban fixture's SQLite file; transcripts under a temp
projects folder, as in ``test_feed_api.py``.  Both sides are asked with the
same ``?project=`` so the queue joins them.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from web import workflow_queue as wq

PROJECT = "C--Users-test-Documents-queue"


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
                      "replies": [{"key": "A", "label": "One field that formats as you type", "reply": "One field"}]})
WORKING = _card(type="working", title="Nightly report", headline="Rebuilding the nightly report; about 40 minutes left.",
                needs={"kind": "none", "why": "Runs by itself.", "next": "Sends a sample.", "eta_minutes": 40,
                       "stages": ["Template", "Numbers"], "stage": "Numbers"})


def _iso(minutes_ago):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _msg(kind, text, ts, sid):
    return json.dumps({"type": kind, "message": {"role": kind, "content": [{"type": "text", "text": text}]},
                       "timestamp": ts, "sessionId": sid})


def _with_card(prose, card):
    return prose + "\n\n```handoff\n" + json.dumps(card) + "\n```\n"


def _write(proj, sid, lines):
    (proj / f"{sid}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


@pytest.fixture()
def projects_root(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    root.mkdir()
    (root / PROJECT).mkdir()
    import web.config as cfg
    import web.routes.sessions_api as sa
    import web.sessions as sess
    monkeypatch.setattr(cfg, "_CLAUDE_PROJECTS", root)
    monkeypatch.setattr(sa, "_CLAUDE_PROJECTS", root)
    monkeypatch.setattr(wq, "_ORDER_DIR", tmp_path / "queue_order")
    cfg._summary_cache.clear()
    cfg._summary_cache_index.clear()
    sess._orphan_cache.clear()
    sess._card_cache.clear()
    return root


@pytest.fixture()
def seeded(projects_root):
    proj = projects_root / PROJECT
    _write(proj, "s-pick", [_msg("user", "build the form", _iso(30), "s-pick"),
                            _msg("assistant", _with_card("Three fields.", DECIDE), _iso(10), "s-pick")])
    _write(proj, "s-done", [_msg("user", "add archive", _iso(60), "s-done"),
                            _msg("assistant", _with_card("Done.", _card()), _iso(50), "s-done")])
    _write(proj, "s-night", [_msg("user", "rebuild", _iso(70), "s-night"),
                             _msg("assistant", _with_card("Running.", WORKING), _iso(65), "s-night")])
    _write(proj, "s-loose", [_msg("user", "a loose one", _iso(20), "s-loose"),
                             _msg("assistant", _with_card("Loose.", _card(title="Loose end")), _iso(15), "s-loose")])
    return proj


def _mk(client, title, parent_id=None, status="not_started"):
    r = client.post(f"/api/kanban/tasks?project={PROJECT}", json={"title": title, "parent_id": parent_id, "status": status})
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()


def _link(client, task_id, sid):
    r = client.post(f"/api/kanban/tasks/{task_id}/sessions?project={PROJECT}", json={"session_id": sid})
    assert r.status_code == 200, r.get_data(as_text=True)


def _queue(client):
    r = client.get(f"/api/queue?project={PROJECT}")
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()


# ── The pure rules ──────────────────────────────────────────────────────────

class TestRules:
    def test_a_task_shows_its_most_urgent_session_or_child(self):
        assert wq.task_verb(["review", "working"], [], "working") == "review"
        assert wq.task_verb(["working"], ["decide"], "working") == "decide"
        assert wq.task_verb([], ["done", "working"], "working") == "working"

    def test_no_session_means_not_started_unless_marked_complete(self):
        assert wq.task_verb([], [], "not_started") == "new"
        assert wq.task_verb([], [], "complete") == "done"
        assert wq.group_of("new") == "new" and wq.LABEL["new"] == "Not started"

    def test_groups_stay_fixed_and_the_saved_order_rules_inside_them(self):
        tasks = [{"id": "a", "title": "A", "status": "working", "position": 1},
                 {"id": "b", "title": "B", "status": "not_started", "position": 2},
                 {"id": "c", "title": "C", "status": "working", "position": 3}]
        items = {"s1": {"session_id": "s1", "verb": "review", "group": "needs", "label": "Review", "ts": 5, "headline": "h1"},
                 "s3": {"session_id": "s3", "verb": "working", "group": "working", "label": "Working", "ts": 9}}
        rows = wq.build(tasks, {}, {"a": ["s1"], "c": ["s3"]}, items, ["c", "a"])
        assert [r["id"] for r in rows] == ["a", "c", "b"]        # needs, working, new: the saved order never crosses a group
        rows = wq.build(tasks + [{"id": "d", "title": "D", "status": "not_started", "position": 0}], {}, {}, {}, ["b", "d"])
        assert [r["id"] for r in rows[:2]] == ["b", "d"]           # inside the group, the saved order

    def test_children_roll_up_into_their_parent(self):
        tasks = [{"id": "p", "title": "P", "status": "working", "position": 1}]
        kids = {"p": [{"id": "k1", "title": "K1", "status": "working", "position": 1}, {"id": "k2", "title": "K2", "status": "complete", "position": 2}]}
        items = {"s1": {"session_id": "s1", "verb": "decide", "group": "needs", "label": "Decide", "ts": 1, "headline": "pick"}}
        row = wq.build(tasks, kids, {"k1": ["s1"]}, items, [])[0]
        assert row["verb"] == "decide" and row["children_done"] == 1 and len(row["children"]) == 2
        assert row["children"][0]["latest"] == "pick"

    def test_order_is_saved_per_project_and_a_bad_name_is_refused(self, tmp_path, monkeypatch):
        monkeypatch.setattr(wq, "_ORDER_DIR", tmp_path / "qo")
        assert wq.save_order("C--proj", ["b", "a", "b", ""]) is True
        assert wq.load_order("C--proj") == ["b", "a"]
        assert wq.save_order("../x", ["a"]) is False and wq.load_order("../x") == []

    def test_the_orchestrator_contract_names_the_task_and_the_route(self):
        text = wq.orchestrator_prompt("t-1", "s-9")
        assert "/api/queue/tasks/t-1/subsessions" in text and '"parent_session_id": "s-9"' in text
        assert "SUBSESSION" in text and "SUBAGENT" in text and "never mark the task complete" in text
        brief = wq.subsession_brief("t-1", 'the "form"')
        assert "subsession:report" in brief and "the 'form'" in brief


# ── The routes ──────────────────────────────────────────────────────────────

class TestQueueRoute:
    def test_tasks_read_their_status_off_their_sessions_cards(self, kanban_app, projects_root, seeded):
        app, client, repo = kanban_app
        a = _mk(client, "Checkout redesign", status="working")
        b = _mk(client, "Nightly emails", status="working")
        c = _mk(client, "Import from Shopify")
        d = _mk(client, "Old one", status="complete")
        _link(client, a["id"], "s-pick")
        _link(client, b["id"], "s-night")
        q = _queue(client)
        by = {t["title"]: t for t in q["tasks"]}
        assert [t["title"] for t in q["tasks"]] == ["Checkout redesign", "Nightly emails", "Import from Shopify", "Old one"]
        assert by["Checkout redesign"]["verb"] == "decide" and by["Checkout redesign"]["latest"] == "Pick how the card-number field reads."
        assert by["Nightly emails"]["verb"] == "waiting" and by["Nightly emails"]["sessions"][0]["eta_minutes"] == 40
        assert by["Import from Shopify"]["group"] == "new" and by["Import from Shopify"]["label"] == "Not started"
        assert by["Old one"]["group"] == "done"
        # The sessions no task owns are listed as unfiled, newest first, with their cards.
        assert [s["session_id"] for s in q["unfiled"]] == ["s-loose", "s-done"]
        assert q["unfiled"][0]["card"]["title"] == "Loose end"

    def test_children_sit_under_their_parent_and_move_it(self, kanban_app, projects_root, seeded):
        app, client, repo = kanban_app
        p = _mk(client, "Checkout redesign", status="working")
        k = _mk(client, "Payment form", parent_id=p["id"], status="working")
        _link(client, k["id"], "s-pick")
        q = _queue(client)
        assert [t["title"] for t in q["tasks"]] == ["Checkout redesign"]      # a child is never a top-level row
        row = q["tasks"][0]
        assert row["verb"] == "decide" and row["children"][0]["title"] == "Payment form"
        assert row["children"][0]["sessions"][0]["session_id"] == "s-pick"

    def test_the_saved_order_rules_inside_a_group(self, kanban_app, projects_root, seeded):
        app, client, repo = kanban_app
        a = _mk(client, "First made")
        b = _mk(client, "Second made")
        c = _mk(client, "Third made")
        assert [t["title"] for t in _queue(client)["tasks"]] == ["First made", "Second made", "Third made"]
        r = client.post(f"/api/queue/order?project={PROJECT}", json={"ids": [c["id"], a["id"]]})
        assert r.status_code == 200 and r.get_json()["ids"] == [c["id"], a["id"]]
        assert [t["title"] for t in _queue(client)["tasks"]] == ["Third made", "First made", "Second made"]
        assert client.post(f"/api/queue/order?project={PROJECT}", json={"ids": "no"}).status_code == 400


class TestOrchestrator:
    def test_the_prompt_briefs_the_task_and_names_the_session(self, kanban_app, projects_root, seeded):
        app, client, repo = kanban_app
        t = _mk(client, "Checkout redesign")
        r = client.get(f"/api/queue/tasks/{t['id']}/prompt?project={PROJECT}&session_id=abc-123")
        assert r.status_code == 200
        d = r.get_json()
        assert d["name"] == "Checkout redesign" and "orchestrator" in d["prompt"]
        assert "Checkout redesign" in d["system_prompt"]
        assert f"/api/queue/tasks/{t['id']}/subsessions" in d["system_prompt"] and "abc-123" in d["system_prompt"]
        assert client.get(f"/api/queue/tasks/nope/prompt?project={PROJECT}").status_code == 404

    def test_a_subsession_is_a_child_task_with_its_own_briefed_session(self, kanban_app, projects_root, seeded):
        app, client, repo = kanban_app
        app.session_manager.start_session.return_value = {"ok": True}
        t = _mk(client, "Checkout redesign", status="working")
        r = client.post(f"/api/queue/tasks/{t['id']}/subsessions?project={PROJECT}",
                        json={"title": "Payment form", "prompt": "Build the three card-number fields.", "parent_session_id": "s-pick"})
        assert r.status_code == 200, r.get_data(as_text=True)
        d = r.get_json()
        child = repo.get_task(d["task_id"])
        assert child.parent_id == t["id"] and child.title == "Payment form"
        assert [ts.session_id for ts in repo.get_task_sessions(child.id)] == [d["session_id"]]
        kw = app.session_manager.start_session.call_args.kwargs
        assert kw["session_id"] == d["session_id"] and kw["session_type"] == "subsession"
        assert kw["parent_session_id"] == "s-pick" and kw["prompt"] == "Build the three card-number fields."
        assert "subsession:report" in kw["system_prompt"] and "Payment form" in kw["system_prompt"]
        # The queue shows it under its parent.
        row = _queue(client)["tasks"][0]
        assert row["children"][0]["title"] == "Payment form"

    def test_one_level_only_and_both_fields_required(self, kanban_app, projects_root, seeded):
        app, client, repo = kanban_app
        app.session_manager.start_session.return_value = {"ok": True}
        t = _mk(client, "Top")
        k = _mk(client, "Part", parent_id=t["id"])
        r = client.post(f"/api/queue/tasks/{k['id']}/subsessions?project={PROJECT}", json={"title": "Deeper", "prompt": "x", "parent_session_id": "s"})
        assert r.status_code == 409
        assert client.post(f"/api/queue/tasks/{t['id']}/subsessions?project={PROJECT}", json={"title": "", "prompt": "x"}).status_code == 400
        assert client.post(f"/api/queue/tasks/nope/subsessions?project={PROJECT}", json={"title": "a", "prompt": "x"}).status_code == 404

    def test_a_session_that_fails_to_start_is_reported_and_leaves_no_link(self, kanban_app, projects_root, seeded):
        app, client, repo = kanban_app
        app.session_manager.start_session.return_value = {"ok": False, "error": "engine down"}
        t = _mk(client, "Top")
        r = client.post(f"/api/queue/tasks/{t['id']}/subsessions?project={PROJECT}", json={"title": "Part", "prompt": "x", "parent_session_id": "s"})
        assert r.status_code == 502 and "engine down" in r.get_json()["error"]
        child = repo.get_task(r.get_json()["task_id"])
        assert child is not None and repo.get_task_sessions(child.id) == []

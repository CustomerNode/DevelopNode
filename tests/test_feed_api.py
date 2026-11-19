"""The Workflow feed: ``GET /api/feed`` lists one item per session that has a
newest summary card or live work, in reading order, with the card behind
it (``src/web/feed.py``, ``web.sessions.session_card``).

Project directories live under tmp_path; ``_CLAUDE_PROJECTS`` is patched
there, as in ``test_sessions_query.py``.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest


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
EMAIL = _card(type="deliverable", title="Receipt email", headline="The receipt email is drafted for you to send.",
              deliverable={"kind": "email", "title": "Your order", "body": "Hi"})
WORKING = _card(type="working", title="Nightly report", headline="Rebuilding the nightly report; about 40 minutes left.",
                needs={"kind": "none", "why": "Runs by itself.", "next": "Sends a sample.", "eta_minutes": 40,
                       "stages": ["Template", "Numbers"], "stage": "Numbers"})


def _iso(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _msg(kind, text, ts, sid):
    return json.dumps({"type": kind, "message": {"role": kind, "content": [{"type": "text", "text": text}]},
                       "timestamp": ts, "sessionId": sid})


def _with_card(prose, card):
    return prose + "\n\n```handoff\n" + json.dumps(card) + "\n```\n"


def _write(proj, sid, lines):
    p = proj / f"{sid}.jsonl"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


@pytest.fixture()
def projects_root(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    root.mkdir()
    import web.config as cfg
    import web.routes.sessions_api as sa
    import web.sessions as sess
    monkeypatch.setattr(cfg, "_CLAUDE_PROJECTS", root)
    monkeypatch.setattr(sa, "_CLAUDE_PROJECTS", root)
    cfg._summary_cache.clear()
    cfg._summary_cache_index.clear()
    sess._orphan_cache.clear()
    sess._card_cache.clear()
    return root


@pytest.fixture()
def project(projects_root):
    name = "C--Users-test-Documents-feed"
    (projects_root / name).mkdir()
    return name


@pytest.fixture()
def app():
    from web import create_app
    return create_app(testing=True)


@pytest.fixture()
def seeded(projects_root, project):
    proj = projects_root / project
    # A pick waits (newest of the two needs-you cards).
    _write(proj, "pick", [_msg("user", "build the payment form", _iso(30), "pick"),
                          _msg("assistant", _with_card("Three fields are built.", DECIDE), _iso(10), "pick")])
    # Done, for the person's review.
    _write(proj, "done", [_msg("user", "add archive", _iso(60), "done"),
                          _msg("assistant", _with_card("Done.", _card()), _iso(50), "done")])
    # A draft to send.
    _write(proj, "sent", [_msg("user", "draft the receipt", _iso(45), "sent"),
                          _msg("assistant", _with_card("Drafted.", EMAIL), _iso(40), "sent")])
    # Its card is stale: the person wrote again after it (a new turn began).
    _write(proj, "stale", [_msg("user", "start", _iso(90), "stale"),
                           _msg("assistant", _with_card("Done.", _card()), _iso(80), "stale"),
                           _msg("user", "now do the other thing", _iso(20), "stale")])
    # No card at all: not in the feed.
    _write(proj, "plain", [_msg("user", "hello", _iso(5), "plain"),
                           _msg("assistant", "hi there", _iso(4), "plain")])
    # A Done the person gave: sinks to the end.
    _write(proj, "held", [_msg("user", "fix it", _iso(200), "held"),
                          _msg("assistant", _with_card("Fixed.", _card(title="Login fix")), _iso(190), "held")])
    # A Working card from a session that has since stopped: Waiting.
    _write(proj, "nightly", [_msg("user", "rebuild the report", _iso(70), "nightly"),
                             _msg("assistant", _with_card("Running.", WORKING), _iso(65), "nightly")])
    return proj


def _feed(app, project):
    r = app.test_client().get(f"/api/feed?project={project}")
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()["items"]


def _hold_done(app, project, projects_root, sid):
    from web import session_holds
    from web.sessions import load_session_summary
    row = load_session_summary(projects_root / project / f"{sid}.jsonl")
    session_holds.set_hold(projects_root / project, sid, "done", row["last_activity_ts"])


class TestFeedOrder:
    def test_only_sessions_with_a_card_or_live_work_are_listed(self, app, project, projects_root, seeded):
        ids = [it["session_id"] for it in _feed(app, project)]
        assert "plain" not in ids          # no card, nothing running
        assert "stale" not in ids          # its card is behind a newer message of the person's
        assert set(ids) == {"pick", "done", "sent", "held", "nightly"}

    def test_reading_order_is_cant_go_on_then_verdict_then_working_then_done(self, app, project, projects_root, seeded):
        _hold_done(app, project, projects_root, "held")
        app.session_manager.get_all_states.return_value = [
            {"session_id": "stale", "state": "working", "cwd": ""},
            {"session_id": "live-only", "state": "starting", "cwd": ""},
        ]
        items = _feed(app, project)
        verbs = [(it["session_id"], it["verb"]) for it in items]
        # A live session with no transcript yet is the newest thing there is
        # (the listing stamps it "now"), so it leads the Working group.
        assert verbs == [("pick", "decide"), ("done", "review"), ("sent", "send"),
                         ("live-only", "working"), ("stale", "working"), ("nightly", "waiting"), ("held", "done")]
        groups = [it["group"] for it in items]
        assert groups == ["needs", "needs", "needs", "working", "working", "working", "done"]

    def test_live_state_beats_the_card_and_a_permission_is_approve(self, app, project, projects_root, seeded):
        app.session_manager.get_all_states.return_value = [
            {"session_id": "pick", "state": "waiting", "cwd": ""},
            {"session_id": "done", "state": "working", "cwd": ""},
        ]
        by = {it["session_id"]: it for it in _feed(app, project)}
        assert by["pick"]["verb"] == "approve"
        assert by["done"]["verb"] == "working"
        # The card still travels, so the line can open it.
        assert by["pick"]["card"]["title"] == "Card number field"

    def test_states_of_other_projects_and_utility_sessions_are_ignored(self, app, project, projects_root, seeded):
        app.session_manager.get_all_states.return_value = [
            {"session_id": "pick", "state": "working", "cwd": "/somewhere/else", "session_type": "session"},
            {"session_id": "_title-x", "state": "working", "cwd": ""},
            {"session_id": "plan", "state": "working", "cwd": "", "session_type": "planner"},
        ]
        by = {it["session_id"]: it for it in _feed(app, project)}
        assert by["pick"]["verb"] == "decide"         # another project's state does not touch it
        assert "_title-x" not in by and "plan" not in by


class TestFeedItem:
    def test_the_line_is_the_cards_title_headline_and_ask(self, app, project, projects_root, seeded):
        by = {it["session_id"]: it for it in _feed(app, project)}
        pick = by["pick"]
        assert pick["title"] == "Card number field"
        assert pick["headline"] == "Pick how the card-number field reads."
        assert pick["line"] == "Which card-number field goes on the form?"
        assert pick["label"] == "Decide"
        assert pick["card"]["needs"]["replies"][0]["reply"] == "One field"
        assert by["nightly"]["eta_minutes"] == 40
        assert by["done"]["eta_minutes"] is None

    def test_a_live_session_without_a_transcript_is_listed_as_working(self, app, project, projects_root, seeded):
        app.session_manager.get_all_states.return_value = [{"session_id": "fresh", "state": "working", "cwd": ""}]
        by = {it["session_id"]: it for it in _feed(app, project)}
        assert by["fresh"]["verb"] == "working" and by["fresh"]["card"] is None

    def test_a_card_under_the_launch_id_is_found_for_the_renamed_session(self, app, project, projects_root, seeded):
        app.session_manager._id_aliases = {"pick": "pick-renamed"}
        by = {it["session_id"]: it for it in _feed(app, project)}
        assert "pick" not in by
        assert by["pick-renamed"]["verb"] == "decide"
        assert by["pick-renamed"]["card"]["title"] == "Card number field"

    def test_the_sidebar_rows_do_not_carry_the_card(self, app, project, projects_root, seeded):
        rows = app.test_client().get(f"/api/sessions?project={project}").get_json()
        assert rows and all("card" not in r for r in rows)
        assert {r["id"] for r in rows if r.get("next_step")} == {"pick", "done", "sent", "held", "nightly"}


class TestCardCache:
    def test_a_grown_transcript_serves_its_new_card(self, app, project, projects_root, seeded):
        from web.sessions import session_card
        assert session_card(project, "done")["title"] == "Archive sessions"
        import os
        import time
        p = projects_root / project / "done.jsonl"
        with p.open("a", encoding="utf-8") as f:
            f.write(_msg("user", "again", _iso(3), "done") + "\n")
            f.write(_msg("assistant", _with_card("Again.", _card(title="Second pass")), _iso(2), "done") + "\n")
        os.utime(p, (time.time() + 5, time.time() + 5))
        assert session_card(project, "done")["title"] == "Second pass"

    def test_missing_transcript_has_no_card(self, app, project, projects_root):
        from web.sessions import session_card
        assert session_card(project, "nope") is None

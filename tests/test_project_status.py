"""The project picker's status columns: Needs you, Standby and Working per
project (Done is not counted).

Server: ``src/web/project_status.py`` and ``GET /api/project-status``.
Browser: ``_renderProjectOverlay`` in ``src/web/static/js/app.js``, run in
headless Chromium against the real page's scripts.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest


def _line(kind, text, ts, sid):
    return json.dumps({"type": kind, "message": {"role": kind, "content": text}, "timestamp": ts, "sessionId": sid})


def _iso(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _card(**c):
    return "Here it is.\n\n```handoff\n" + json.dumps(c) + "\n```"


class _FakeEngine:
    def __init__(self, states):
        self._states = states

    def get_all_states(self):
        return list(self._states)


@pytest.fixture()
def projects(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    root.mkdir()
    import web.config as cfg
    import web.routes.project_api as pa
    import web.sessions as sess
    monkeypatch.setattr(cfg, "_CLAUDE_PROJECTS", root)
    monkeypatch.setattr(pa, "_CLAUDE_PROJECTS", root)
    cfg._summary_cache.clear()
    cfg._summary_cache_index.clear()
    sess._orphan_cache.clear()

    def make(name, sessions):
        d = root / name
        d.mkdir()
        for sid, reply in sessions.items():
            lines = [_line("user", "Do the thing", _iso(30), sid)]
            if reply is not None:
                lines.append(_line("assistant", reply, _iso(29), sid))
            (d / f"{sid}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
        return d
    return make


@pytest.fixture()
def app():
    from web import create_app
    return create_app(testing=True)


def test_group_of_follows_the_sidebar_rule():
    from web.project_status import group_of
    assert group_of({"next_step": {"verb": "review"}}, {"state": "waiting"}) == "needs"     # permission open
    assert group_of({"hold": "done"}, {"state": "working"}) == "working"                    # live work wins
    assert group_of({"hold": "done", "next_step": {"verb": "decide"}}, None) is None        # Done is not counted
    assert group_of({"hold": "standby"}, {"state": "idle"}) == "standby"
    assert group_of({"next_step": {"verb": "waiting"}}, None) == "working"
    assert group_of({"next_step": {"verb": "read"}}, None) == "needs"
    assert group_of({"message_count": 0}, None) is None                                    # New
    assert group_of({"message_count": 4}, None) == "needs"                                 # no verdict yet
    assert group_of({"message_count": 4}, {"state": "idle", "retry_at": 123.0}) == "working"
    assert group_of({"next_step": {"verb": "review"}}, {"state": "idle", "substatus": "auto-resuming"}) == "needs"
    assert group_of({"message_count": 2}, {"state": "idle", "substatus": "auto-resuming"}) == "working"


def test_the_route_counts_each_project(app, projects):
    a = projects("C--Users-test-alpha", {
        "ask": _card(type="needs_you", headline="Pick", needs={"kind": "decision"}),
        "done": _card(type="done", headline="Shipped"),
        "aside": _card(type="done", headline="Later"),
        "busy": None,
    })
    projects("C--Users-test-beta", {"quiet": _card(type="explain", headline="Answer")})
    client = app.test_client()
    client.post("/api/session-hold/done", json={"state": "done", "project": a.name})
    client.post("/api/session-hold/aside", json={"state": "standby", "project": a.name})
    app.session_manager = _FakeEngine([
        {"session_id": "busy", "state": "working", "cwd": "C:\\Users\\test\\alpha"},
        {"session_id": "fresh", "state": "starting", "cwd": "C:\\Users\\test\\alpha"},   # no transcript yet
        {"session_id": "elsewhere", "state": "working", "cwd": "C:\\Users\\test\\gamma"},
    ])
    r = client.get("/api/project-status?projects=C--Users-test-alpha,C--Users-test-beta,missing,..")
    assert r.status_code == 200
    data = r.get_json()
    assert data == {
        "C--Users-test-alpha": {"needs": 1, "standby": 1, "working": 2},
        "C--Users-test-beta": {"needs": 1, "standby": 0, "working": 0},
    }


def test_no_projects_named_is_an_empty_answer(app, projects):
    app.session_manager = _FakeEngine([])
    assert app.test_client().get("/api/project-status").get_json() == {}


def test_detail_lists_the_sessions_in_each_group(app, projects):
    """?detail=1 (the Home screen's project preview): the sessions behind each
    count, newest activity and a 7-day count; without it the answer is unchanged."""
    a = projects("C--Users-test-alpha", {
        "ask": _card(type="needs_you", headline="Pick", needs={"kind": "decision"}),
        "busy": None,
    })
    client = app.test_client()
    app.session_manager = _FakeEngine([{"session_id": "busy", "state": "working", "cwd": "C:\\Users\\test\\alpha"}])
    plain = client.get("/api/project-status?projects=" + a.name).get_json()
    assert plain == {a.name: {"needs": 1, "standby": 0, "working": 1}}
    d = client.get("/api/project-status?detail=1&projects=" + a.name).get_json()[a.name]
    assert (d["needs"], d["working"]) == (1, 1)
    assert [x["id"] for x in d["items"]["needs"]] == ["ask"]
    assert [x["id"] for x in d["items"]["working"]] == ["busy"]
    assert d["items"]["needs"][0]["title"]
    assert d["last_ts"] > 0
    assert len(d["daily"]) == 7 and sum(d["daily"]) == 2     # both active in the last week

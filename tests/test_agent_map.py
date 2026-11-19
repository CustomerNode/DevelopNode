"""The Workflow agent map: where each session is in the codebase
(``src/web/agent_map.py``, ``GET /api/agents``)."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from web import agent_map

PROJECT = "C--Users-test-Documents-agents"


def _iso(minutes_ago):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _tool_line(ts, *blocks):
    return json.dumps({"type": "assistant", "timestamp": ts, "sessionId": "s", "message": {"role": "assistant", "content": list(blocks)}})


def _tool(name, **inp):
    return {"type": "tool_use", "id": "t", "name": name, "input": inp}


CARD = {"type": "working", "title": "Order summary", "headline": "Rebuilding the summary rows.", "answer": "a", "explained": "## x\n\n" + "w " * 45,
        "full_answer": "## y\n\nz", "zoom": {"big": "b", "task": "t", "now": "n"}, "what_was_done": "d", "checked": "c",
        "needs": {"kind": "none", "why": "runs", "next": "merges", "eta_minutes": 25, "stages": ["a", "b"], "stage": "b"}}


class TestWords:
    def test_each_tool_reads_as_the_thread_says_it(self):
        cwd = "/home/x/proj"
        assert agent_map.describe_tool("Read", {"file_path": "/home/x/proj/src/a.py"}, cwd) == {"verb": "Read", "obj": "a.py", "file": "src/a.py"}
        assert agent_map.describe_tool("Edit", {"file_path": "/home/x/proj/src/b.js", "old_string": "x"}, cwd)["verb"] == "Changed"
        assert agent_map.describe_tool("Write", {"file_path": "/elsewhere/c.md"}, cwd) == {"verb": "Wrote", "obj": "c.md", "file": "/elsewhere/c.md"}
        assert agent_map.describe_tool("Grep", {"pattern": "def main"}, cwd) == {"verb": "Searched for", "obj": "def main", "file": None}
        assert agent_map.describe_tool("Bash", {"command": "pytest -q", "description": "Run the tests"}, cwd)["obj"] == "Run the tests"
        assert agent_map.describe_tool("Agent", {"description": "Review the diff", "prompt": "..."}, cwd)["verb"] == "Asked a helper:"
        assert agent_map.describe_tool("WebSearch", {"query": "flask sessions"}, cwd)["verb"] == "Searched the web for"
        assert agent_map.describe_tool("mcp__x__thing", {}, cwd) == {"verb": "Used", "obj": "mcp__x__thing", "file": None}

    def test_folders_count_the_files_own_folder(self):
        assert agent_map.folders_of(["src/a.py", "src/b.py", "tests/t.py", "README.md"]) == {"src": 2, "tests": 1, ".": 1}


class TestActivity:
    def test_the_tail_gives_files_newest_first_and_the_last_steps(self, tmp_path):
        cwd = str(tmp_path / "proj")
        p = tmp_path / "s.jsonl"
        lines = [
            json.dumps({"type": "user", "timestamp": _iso(30), "message": {"role": "user", "content": "go"}}),
            _tool_line(_iso(20), _tool("Read", file_path=f"{cwd}/src/a.py")),
            _tool_line(_iso(15), _tool("Edit", file_path=f"{cwd}/src/a.py", old_string="x", new_string="y"), _tool("Edit", file_path=f"{cwd}/src/b.py", old_string="x", new_string="y")),
            _tool_line(_iso(10), _tool("Bash", command="pytest -q tests/", description="Run the tests")),
            json.dumps({"type": "assistant", "timestamp": _iso(9), "isSidechain": True, "message": {"role": "assistant", "content": [_tool("Write", file_path=f"{cwd}/side.py")]}}),
            _tool_line(_iso(5), _tool("Write", file_path=f"{cwd}/tests/test_a.py", content="...")),
        ]
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")
        act = agent_map.recent_activity(p, cwd)
        assert act["files"] == ["tests/test_a.py", "src/b.py", "src/a.py"]      # a helper's side work is not this agent's
        assert [s["verb"] for s in act["steps"]] == ["Wrote", "Ran", "Changed", "Changed", "Read"]
        assert act["steps"][0]["obj"] == "test_a.py" and act["steps"][1]["obj"] == "Run the tests"
        assert act["last_ts"] > 0

    def test_only_the_tail_is_read_and_a_missing_file_is_empty(self, tmp_path):
        cwd = str(tmp_path)
        p = tmp_path / "big.jsonl"
        old = _tool_line(_iso(90), _tool("Read", file_path=f"{cwd}/old.py"))
        pad = json.dumps({"type": "user", "timestamp": _iso(80), "message": {"role": "user", "content": "x" * 4000}})
        new = _tool_line(_iso(1), _tool("Read", file_path=f"{cwd}/new.py"))
        p.write_text(old + "\n" + "\n".join([pad] * 60) + "\n" + new + "\n", encoding="utf-8")
        act = agent_map.recent_activity(p, cwd, tail_bytes=20_000)
        assert act["files"] == ["new.py"]
        assert agent_map.recent_activity(tmp_path / "nope.jsonl", cwd) == {"files": [], "steps": [], "last_ts": 0.0}


class TestTree:
    def test_folders_with_counts_skip_caches_and_are_cached(self, tmp_path, monkeypatch):
        root = tmp_path / "proj"
        for f in ["src/web/a.py", "src/web/b.py", "src/engine/c.py", "tests/t.py", "README.md", "node_modules/x/y.js", ".git/HEAD", "data/z.json"]:
            (root / f).parent.mkdir(parents=True, exist_ok=True)
            (root / f).write_text("x")
        agent_map._tree_cache.clear()
        tree = {t["path"]: t["files"] for t in agent_map.project_tree(str(root))}
        assert tree == {"src": 3, "src/web": 2, "src/engine": 1, "tests": 1, ".": 1}
        (root / "tests" / "u.py").write_text("x")
        assert {t["path"]: t["files"] for t in agent_map.project_tree(str(root))}["tests"] == 1   # cached for a minute
        agent_map._tree_cache.clear()
        assert {t["path"]: t["files"] for t in agent_map.project_tree(str(root))}["tests"] == 2
        assert agent_map.project_tree("") == [] and agent_map.project_tree(str(tmp_path / "nope")) == []


@pytest.fixture()
def projects_root(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    (root / PROJECT).mkdir(parents=True)
    import web.config as cfg
    import web.routes.sessions_api as sa
    import web.sessions as sess
    monkeypatch.setattr(cfg, "_CLAUDE_PROJECTS", root)
    monkeypatch.setattr(sa, "_CLAUDE_PROJECTS", root)
    cfg._summary_cache.clear()
    cfg._summary_cache_index.clear()
    sess._orphan_cache.clear()
    sess._card_cache.clear()
    agent_map._tree_cache.clear()
    return root


class TestRoute:
    def test_agents_with_their_folders_steps_and_cards(self, projects_root, tmp_path, monkeypatch):
        from web import create_app
        import web.routes.sessions_api as sa
        cwd = tmp_path / "code"
        for f in ["src/a.py", "src/b.py", "tests/t.py"]:
            (cwd / f).parent.mkdir(parents=True, exist_ok=True)
            (cwd / f).write_text("x")
        monkeypatch.setattr(sa, "_decode_project", lambda p: str(cwd))
        proj = projects_root / PROJECT
        card = "Working.\n\n```handoff\n" + json.dumps(CARD) + "\n```\n"
        (proj / "s-work.jsonl").write_text("\n".join([
            json.dumps({"type": "user", "timestamp": _iso(30), "message": {"role": "user", "content": "go"}, "sessionId": "s-work"}),
            _tool_line(_iso(20), _tool("Edit", file_path=f"{cwd}/src/a.py", old_string="x", new_string="y")),
            _tool_line(_iso(10), _tool("Bash", command="pytest", description="Run the tests")),
            json.dumps({"type": "assistant", "timestamp": _iso(5), "sessionId": "s-work", "message": {"role": "assistant", "content": [{"type": "text", "text": card}]}}),
        ]) + "\n", encoding="utf-8")
        # A session with a card but no file touched is not on the map unless it runs.
        (proj / "s-idle.jsonl").write_text("\n".join([
            json.dumps({"type": "user", "timestamp": _iso(30), "message": {"role": "user", "content": "hi"}, "sessionId": "s-idle"}),
            json.dumps({"type": "assistant", "timestamp": _iso(5), "sessionId": "s-idle", "message": {"role": "assistant", "content": [{"type": "text", "text": card}]}}),
        ]) + "\n", encoding="utf-8")
        app = create_app(testing=True)
        app.session_manager.get_all_states.return_value = [{"session_id": "s-work", "state": "working", "cwd": ""}]
        r = app.test_client().get(f"/api/agents?project={PROJECT}")
        assert r.status_code == 200, r.get_data(as_text=True)
        d = r.get_json()
        assert {t["path"]: t["files"] for t in d["tree"]} == {"src": 2, "tests": 1}
        assert [a["session_id"] for a in d["agents"]] == ["s-work"]
        a = d["agents"][0]
        assert a["live"] is True and a["verb"] == "working" and a["files"] == ["src/a.py"] and a["folders"] == {"src": 1}
        assert [s["verb"] for s in a["steps"]] == ["Ran", "Changed"]
        assert a["card"]["title"] == "Order summary"

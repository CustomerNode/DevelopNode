"""Where agents are: what is read from the transcripts, the folder and file
reads that must stay inside a project, the three routes, and how the page
loads the view (a sidebar button; the 3D library only on first open)."""
import json
import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from web import agent_fleet  # noqa: E402

STATIC = ROOT / "src" / "web" / "static"
INDEX = ROOT / "src" / "web" / "templates" / "index.html"


def _line(typ, content, ts="2030-01-02T03:04:05Z", sidechain=False, **extra):
    return json.dumps({"type": typ, "timestamp": ts, "isSidechain": sidechain,
                       "message": {"role": typ, "content": content}, **extra})


def _tool(name, **inp):
    return {"type": "tool_use", "name": name, "input": inp}


@pytest.fixture
def project(tmp_path):
    """A project folder with a few files, and a sessions folder with one
    session that launched one helper."""
    cwd = tmp_path / "shop"
    (cwd / "src" / "pay").mkdir(parents=True)
    (cwd / "src" / "pay" / "card.py").write_text("def charge():\n    return 1\n", "utf-8")
    (cwd / "src" / "pay" / "logo.bin").write_bytes(b"\x00\x01\x02\xff")
    (cwd / "README.txt").write_text("hello\n", "utf-8")
    (cwd / "node_modules" / "x").mkdir(parents=True)
    (tmp_path / "secret.txt").write_text("outside the project\n", "utf-8")
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    card = str(cwd / "src" / "pay" / "card.py")
    (sessions / "s1.jsonl").write_text("\n".join([
        _line("user", "Make the charge return two"),
        _line("user", "<system-reminder>not something a person said</system-reminder>"),
        _line("assistant", [{"type": "text", "text": "Reading the file first."}, _tool("Read", file_path=card)]),
        _line("assistant", [_tool("Edit", file_path=card, old_string="return 1", new_string="return 2")]),
        _line("assistant", [_tool("Read", file_path=str(tmp_path / "secret.txt"))]),
        _line("assistant", [_tool("Read", file_path=str(cwd / "README.txt"))], sidechain=True),
    ]) + "\n", "utf-8")
    sub = sessions / "s1" / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-h1.meta.json").write_text(json.dumps({"description": "Check the totals", "finished": True}), "utf-8")
    (sub / "agent-h1.jsonl").write_text("\n".join([
        _line("user", "Check the totals add up", sidechain=True),
        _line("assistant", [_tool("Read", file_path=str(cwd / "README.txt"))], sidechain=True),
    ]) + "\n", "utf-8")
    return {"cwd": str(cwd), "sessions": sessions, "tmp": tmp_path}


def test_a_session_reports_its_files_edits_and_what_was_said(project):
    a = agent_fleet.activity(project["sessions"] / "s1.jsonl", project["cwd"], False)
    assert a["files"] == ["src/pay/card.py"]                      # newest first, inside the project only
    assert a["edits"]["src/pay/card.py"][0]["old"] == "return 1"
    assert a["edits"]["src/pay/card.py"][0]["new"] == "return 2"
    assert [m["t"] for m in a["chat"]] == ["Make the charge return two", "Reading the file first."]
    assert a["steps"] and a["last_ts"] > 0


def test_a_helpers_lines_are_never_counted_as_the_sessions(project):
    a = agent_fleet.activity(project["sessions"] / "s1.jsonl", project["cwd"], False)
    assert "README.txt" not in a["files"]


def test_helpers_come_with_their_own_files(project):
    hs = agent_fleet.helpers_of(project["sessions"] / "s1", project["cwd"], time.time())
    assert [h["name"] for h in hs] == ["Check the totals"]
    assert hs[0]["files"] == ["README.txt"] and hs[0]["live"] is False
    assert hs[0]["chat"][0]["t"] == "Check the totals add up"


def test_a_project_lists_working_and_recent_sessions_with_their_names(project):
    now = time.time()
    asked = []

    def rows(path):
        asked.append(path.name)
        return {"custom_title": "Charge fix", "next_step": {"group": "needs_you"}}
    got = agent_fleet.project_agents(project["sessions"], project["cwd"], rows, set(), 72, now)
    assert asked == ["s1.jsonl"]                      # asked only for the sessions that are shown
    assert [(a["id"], a["name"], a["live"], a["group"]) for a in got] == [("s1", "Charge fix", False, "needs_you")]
    assert got[0]["helpers"][0]["name"] == "Check the totals"
    working = agent_fleet.project_agents(project["sessions"], project["cwd"], rows, {"s1"}, 72, now)
    assert working[0]["live"] is True and working[0]["group"] == "working"


def test_an_old_session_is_left_out_unless_it_is_working(project):
    old = time.time() - 30 * 86400
    os.utime(project["sessions"] / "s1.jsonl", (old, old))
    now = time.time()
    assert agent_fleet.project_agents(project["sessions"], project["cwd"], lambda p: {}, set(), 72, now) == []
    assert len(agent_fleet.project_agents(project["sessions"], project["cwd"], lambda p: {}, {"s1"}, 72, now)) == 1


def test_a_listing_holds_the_real_contents_and_skips_dependency_folders(project):
    got = agent_fleet.listing(project["cwd"], "", 3)
    assert got[""]["d"] == ["src"] and got[""]["f"] == ["README.txt"]
    assert got["src/pay"]["f"] == ["card.py", "logo.bin"]
    assert "node_modules" not in got[""]["d"]
    assert set(agent_fleet.listing(project["cwd"], "src", 1)) == {"src"}       # one level only


@pytest.mark.parametrize("rel", ["..", "../", "src/../..", "../secret.txt"])
def test_a_listing_never_leaves_the_project(project, rel):
    assert agent_fleet.listing(project["cwd"], rel, 1) is None


def test_file_text_reads_text_and_says_why_it_cannot(project):
    got = agent_fleet.file_text(project["cwd"], "src/pay/card.py")
    assert got == {"kind": "text", "total": 2, "text": "def charge():\n    return 1"}
    assert agent_fleet.file_text(project["cwd"], "src/pay/logo.bin")["kind"] == "binary"
    assert agent_fleet.file_text(project["cwd"], "src/pay/nothing.py")["kind"] == "missing"


@pytest.mark.parametrize("rel", ["../secret.txt", "src/../../secret.txt"])
def test_file_text_never_leaves_the_project(project, rel):
    assert agent_fleet.file_text(project["cwd"], rel) == {"kind": "missing"}


def test_a_link_out_of_the_project_is_not_followed(project):
    link = Path(project["cwd"]) / "out.txt"
    try:
        link.symlink_to(project["tmp"] / "secret.txt")
    except (OSError, NotImplementedError):
        pytest.skip("this account cannot create a symbolic link")
    assert agent_fleet.file_text(project["cwd"], "out.txt") == {"kind": "missing"}


@pytest.fixture
def client(project, monkeypatch):
    from web import create_app
    from web.routes import fleet_api
    app = create_app(testing=True)
    monkeypatch.setattr(fleet_api, "_projects", lambda: [{"encoded": "enc-shop", "display": project["cwd"], "custom_name": "Shop"}])
    monkeypatch.setattr(fleet_api, "_CLAUDE_PROJECTS", project["tmp"] / "projects")
    (project["tmp"] / "projects").mkdir()
    project["sessions"].rename(project["tmp"] / "projects" / "enc-shop")
    monkeypatch.setattr(fleet_api, "load_session_summary", lambda path: {"id": path.stem, "custom_title": "Charge fix"})
    monkeypatch.setattr(fleet_api, "_live_ids", lambda: {"s1"})
    return app.test_client()


def test_the_fleet_route_returns_every_projects_agents(client):
    d = client.get("/api/agent-fleet").get_json()
    assert [p["name"] for p in d["projects"]] == ["Shop"]
    a = d["projects"][0]["agents"][0]
    assert (a["name"], a["live"], a["files"]) == ("Charge fix", True, ["src/pay/card.py"])
    assert a["helpers"][0]["files"] == ["README.txt"]


def test_the_folder_and_file_routes_serve_only_a_listed_project(client):
    ok = client.get("/api/agent-fleet/dirs?project=enc-shop&path=src&depth=2").get_json()
    assert ok["ok"] and ok["dirs"]["src/pay"]["f"] == ["card.py", "logo.bin"]
    assert client.get("/api/agent-fleet/dirs?project=enc-shop&path=..").status_code == 404
    assert client.get("/api/agent-fleet/dirs?project=someone-else&path=").status_code == 404
    assert client.get("/api/agent-fleet/file?project=someone-else&path=README.txt").status_code == 404
    f = client.get("/api/agent-fleet/file?project=enc-shop&path=src/pay/card.py").get_json()
    assert f["kind"] == "text" and "return 1" in f["text"]
    assert client.get("/api/agent-fleet/file?project=enc-shop&path=../secret.txt").get_json()["kind"] == "missing"


def test_the_view_opens_from_the_rail_selector_and_the_phone_menu():
    html = INDEX.read_text("utf-8")
    js = (STATIC / "js" / "agent-fleet.js").read_text("utf-8")
    # One way in on the rail: the view selector (js/view-rail.js), not a button of its own.
    assert "btn-agent-fleet" not in js and "btn-agent-fleet" not in html
    assert "vn:agent-fleet" in js                        # the selector's mark follows the view opening and closing
    assert "['fleet', 'Where agents are'" in (STATIC / "js" / "topbar.js").read_text("utf-8")
    assert html.count("versioned_static('js/agent-fleet.js')") == 1
    assert html.count("versioned_static('css/agent-fleet.css')") == 1


def test_the_3d_library_is_loaded_on_first_open_never_at_startup():
    # The library is over 1 MB: the page must not fetch it until the view opens.
    assert "vendor/three" not in INDEX.read_text("utf-8")
    js = (STATIC / "js" / "agent-fleet.js").read_text("utf-8")
    assert "import('/static/vendor/three/three.module.js')" in js
    for name in ("three.module.js", "OrbitControls.js", "CSS2DRenderer.js", "LICENSE"):
        assert (STATIC / "vendor" / "three" / name).is_file(), name
    # The two helpers import the library by a path a browser can resolve with no import map.
    for name in ("OrbitControls.js", "CSS2DRenderer.js"):
        text = (STATIC / "vendor" / "three" / name).read_text("utf-8")
        assert "from './three.module.js'" in text and "from 'three'" not in text


def test_the_view_takes_its_colours_from_the_theme():
    css = (STATIC / "css" / "agent-fleet.css").read_text("utf-8")
    for var in ("--accent", "--bg-body", "--text-primary", "--text-heading"):
        assert f"var({var}" in css, var
    # Scoped: no rule may reach outside the view.
    for line in css.splitlines():
        if line.rstrip().endswith("{") and not line.startswith((" ", "@", "/*")):
            assert line.startswith("#agent-fleet"), line

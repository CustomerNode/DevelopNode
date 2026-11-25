"""The project list is ordered by project name, or by a saved order."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from web import project_order  # noqa: E402


def _row(enc, display, custom="", phoned=False):
    r = {"encoded": enc, "display": display, "custom_name": custom}
    if phoned:
        r["phoned"] = True
    return r


def test_default_order_is_the_name_not_the_path():
    rows = [
        _row("a", "/home/x/Documents/zeta"),
        _row("b", "/home/x/work/Alpha"),
        _row("c", "/home/x/Documents/beta"),
    ]
    got = [r["encoded"] for r in project_order.sort_projects(rows, order=[])]
    assert got == ["b", "c", "a"]


def test_custom_name_wins_and_numbers_sort_as_numbers():
    rows = [
        _row("a", "/h/Documents/aaa", custom="Site 10"),
        _row("b", "/h/Documents/zzz", custom="Site 2"),
        _row("c", "/h/Documents/mmm", custom="apple"),
    ]
    got = [r["encoded"] for r in project_order.sort_projects(rows, order=[])]
    assert got == ["c", "b", "a"]


def test_saved_order_wins_new_projects_follow_by_name_phoned_first():
    rows = [
        _row("a", "/h/Alpha"), _row("b", "/h/Beta"), _row("c", "/h/Gamma"),
        _row("d", "/h/Delta"), _row("p", "/h/Friend", phoned=True),
    ]
    got = [r["encoded"] for r in project_order.sort_projects(rows, order=["c", "a"])]
    assert got == ["p", "c", "a", "b", "d"]


def test_save_and_clear(tmp_path, monkeypatch):
    monkeypatch.setattr(project_order, "_ORDER_FILE", tmp_path / "_project_order.json")
    assert project_order.save_order(["b", "a", "b", 3, "x/y"]) == ["b", "a"]
    assert project_order.load_order() == ["b", "a"]
    assert project_order.save_order([]) == []
    assert project_order.load_order() == []


def test_route_saves_the_order(tmp_path, monkeypatch):
    from web import create_app
    monkeypatch.setattr(project_order, "_ORDER_FILE", tmp_path / "_project_order.json")
    app = create_app(testing=True)
    client = app.test_client()
    resp = client.post("/api/project-order", json={"order": ["x", "y"]})
    assert resp.status_code == 200 and resp.get_json()["order"] == ["x", "y"]
    assert client.post("/api/project-order", json={"order": "nope"}).status_code == 400

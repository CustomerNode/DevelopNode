"""The one-time rename of this computer's shortcuts (src/web/rebrand.py).

Every test builds a made-up home folder and install folder; nothing on the
real machine is read or changed.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from web import rebrand  # noqa: E402


@pytest.fixture
def box(tmp_path, monkeypatch):
    root = tmp_path / "apps" / "VibeNode"
    root.mkdir(parents=True)
    home = tmp_path / "home"
    (home / ".local" / "share" / "applications").mkdir(parents=True)
    (home / "Desktop").mkdir()
    (home / ".config" / "autostart").mkdir(parents=True)
    names = {}
    monkeypatch.setattr(rebrand, "_project_item", lambda r: [])
    monkeypatch.setattr(rebrand.subprocess, "run", lambda *a, **k: None)
    return root, home, tmp_path / "state.json", names


def _launcher(root, name="VibeNode", stop=False):
    exe = f"{root}/src/launcher/stop.sh" if stop else f"cd {root} && ./src/launcher/launch.sh"
    return (f"[Desktop Entry]\nType=Application\nName={name}\n"
            f"Comment=Start {name}\nExec=bash -c '{exe}'\nIcon={root}/static/old.png\n")


def test_finds_and_renames_linux_launchers(box):
    root, home, state, _ = box
    app = home / ".local/share/applications/vibenode.desktop"
    app.write_text(_launcher(root))
    stop = home / "Desktop" / "Stop VibeNode.desktop"
    stop.write_text(_launcher(root, "Stop VibeNode", stop=True))

    st = rebrand.status(root, home, state)
    assert st["show"] is True
    assert {i["becomes"] for i in st["items"]} == {"DevelopNode", "Stop DevelopNode"}

    out = rebrand.apply(root, home, state)
    assert out["ok"]
    text = app.read_text()
    assert "Name=DevelopNode" in text and "Comment=Start DevelopNode" in text
    assert f"Icon={rebrand.ICON_PNG}" in text
    assert app.exists()                      # the menu file keeps its name
    moved = home / "Desktop" / "Stop DevelopNode.desktop"
    assert moved.exists() and not stop.exists()
    assert f"Icon={rebrand.ICON_STOP_PNG}" in moved.read_text()
    assert f"cd {root} &&" in text           # what it starts is untouched

    st = rebrand.status(root, home, state)
    assert st["show"] is False and st["items"] == []


def test_renames_this_installs_background_services_only(box):
    root, home, state, _ = box
    units = home / ".config" / "systemd" / "user"
    units.mkdir(parents=True)
    mine = units / "vibenode-reaper.service"
    mine.write_text(f"[Unit]\nDescription=VibeNode reaper\n[Service]\nExecStart=/usr/bin/python3 {root}/scripts/r.py\n")
    other = units / "other.service"
    other.write_text("[Unit]\nDescription=VibeNode elsewhere\n[Service]\nExecStart=/opt/x/run.py\n")

    st = rebrand.status(root, home, state)
    assert [i["becomes"] for i in st["items"]] == ["DevelopNode reaper"]
    assert rebrand.apply(root, home, state)["ok"]
    assert "Description=DevelopNode reaper" in mine.read_text()
    assert f"ExecStart=/usr/bin/python3 {root}/scripts/r.py" in mine.read_text()   # what it runs is untouched
    assert mine.name == "vibenode-reaper.service"                                   # the name systemd knows it by too
    assert "Description=VibeNode elsewhere" in other.read_text()
    assert rebrand.status(root, home, state)["show"] is False


def test_leaves_launchers_of_other_installs_alone(box):
    root, home, state, _ = box
    other = home / ".local/share/applications/other.desktop"
    other.write_text(_launcher(root.parent / "SomethingElse", "VibeNode"))
    assert rebrand.status(root, home, state)["items"] == []
    rebrand.apply(root, home, state)
    assert "Name=VibeNode" in other.read_text()


def test_a_folder_with_a_longer_name_is_not_this_install(box):
    root, home, state, _ = box
    twin = Path(str(root) + "Copy")
    (home / "Desktop" / "x.desktop").write_text(_launcher(twin))
    assert rebrand.status(root, home, state)["items"] == []


def test_not_now_from_one_browser_never_hides_it_from_the_others(box, monkeypatch):
    """Not now lives in the browser that pressed it (rebrand.js), so a test
    browser pressing it cannot hide the notice from the person."""
    root, home, state, _ = box
    (home / "Desktop" / "vibenode.desktop").write_text(_launcher(root))
    rebrand.later(state)
    assert rebrand.status(root, home, state)["show"] is True
    js = (Path(rebrand.STATIC) / "js" / "rebrand.js").read_text(encoding="utf-8")
    assert "/api/rebrand/later" not in js and "localStorage.setItem(LATER_KEY" in js


def test_nothing_to_rename_shows_nothing(box):
    root, home, state, _ = box
    assert rebrand.status(root, home, state) ["show"] is False


def test_project_name(monkeypatch, tmp_path):
    saved = {}
    import web.config as cfg
    monkeypatch.setattr(cfg, "_load_project_names", lambda: dict(saved))
    monkeypatch.setattr(cfg, "_save_project_names", lambda n: saved.update(n))
    enc = cfg._encode_cwd(str(tmp_path))
    saved[enc] = "VibeNode"
    items = rebrand._project_item(tmp_path)
    assert items and items[0]["becomes"] == "DevelopNode"
    rebrand._apply_project(items[0])
    assert saved[enc] == "DevelopNode"
    assert rebrand._project_item(tmp_path) == []
    saved[enc] = "My own name"                  # a name the person chose stays
    assert rebrand._project_item(tmp_path) == []


def test_the_new_icons_exist():
    for p in (rebrand.ICON_PNG, rebrand.ICON_STOP_PNG, rebrand.ICON_ICO):
        assert p.is_file(), p

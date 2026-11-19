"""VibeNode is now DevelopNode: rename what this computer shows.

An Update renames everything inside the app, but not what lives outside it:
the desktop and app-menu shortcuts, their icons, the sign-in entry's name,
and the name this install's own project carries in the project list.  This
module finds those on this computer and renames them, after the person says
yes in the one-time notice (``static/js/rebrand.js``).

Only what people see changes.  File names that code looks up (the sign-in
entry ``VibeNode.vbs`` / ``vibenode.desktop``, ``com.vibenode.start``), the
install folder and the data folders keep their names: sessions are stored by
folder path, and ``vibenode.py autostart`` finds its entry by file name.

Shortcuts are recognised by what they start (a path inside this install),
never by name alone, so a file that merely mentions the old name is left
alone.  Every change is best effort and reported one by one; nothing here
deletes a file.

State: ``data/rebrand.json`` holds ``done`` (renamed) or ``later`` (asked not
now, with the time).  ``status()`` shows the notice while something is left
to rename and the person has not finished it.  "Not now" is kept by the
browser that pressed it (``rebrand.js``, for a day), never here: a test
browser another session drives against the live app pressed it and hid the
notice from the person on every device.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

OLD = "VibeNode"
NEW = "DevelopNode"
LATER_SECONDS = 24 * 3600

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "web" / "static"
STATE_FILE = ROOT / "data" / "rebrand.json"

ICON_PNG = STATIC / "developnode.png"
ICON_STOP_PNG = STATIC / "developnode_stop.png"
ICON_ICO = STATIC / "developnode.ico"


# ── state ────────────────────────────────────────────────────────────────

def _read_state(path: Path = None) -> dict:
    try:
        return json.loads(Path(path or STATE_FILE).read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_state(data: dict, path: Path = None) -> None:
    p = Path(path or STATE_FILE)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=1), encoding="utf-8")


def later(path: Path = None) -> dict:
    data = {"state": "later", "at": time.time()}
    _write_state(data, path)
    return data


# ── helpers ──────────────────────────────────────────────────────────────

def _inside(text: str, root: Path) -> bool:
    """True when ``text`` names a path inside ``root`` (any separator, any case on Windows)."""
    if not text:
        return False
    r = str(root).replace("\\", "/").rstrip("/")
    t = text.replace("\\", "/")
    if not r:
        return False
    flags = re.I if os.name == "nt" else 0
    return re.search(re.escape(r) + r"(?=$|[/\s'\"&;])", t, flags) is not None


def _had_old(*texts: str) -> bool:
    """True when something carries the old name or one of its icons.

    The notice is for people who had VibeNode.  A fresh DevelopNode install has
    neither, so a launcher with some other icon (one the person picked) is not
    a reason to show it."""
    return any(OLD.lower() in (t or "").lower() for t in texts)


def _renamed(name: str) -> str:
    return name.replace(OLD, NEW).replace(OLD.lower(), NEW.lower())


# ── Linux: .desktop entries ─────────────────────────────────────────────

_FIELD = re.compile(r"^(Name|Comment|Icon)(\[[^\]]*\])?=(.*)$", re.M)


def _desktop_files(home: Path) -> list:
    dirs = [home / ".local" / "share" / "applications", home / "Desktop",
            home / ".config" / "autostart"]
    out = []
    for d in dirs:
        if d.is_dir():
            out += sorted(p for p in d.glob("*.desktop") if p.is_file())
    return out


def _new_desktop_text(text: str) -> str:
    stop = "stop" in text.lower() and re.search(r"^Name=.*stop", text, re.I | re.M)

    def sub(m):
        key, loc, val = m.group(1), m.group(2) or "", m.group(3)
        if key == "Icon":
            return f"Icon={ICON_STOP_PNG if stop else ICON_PNG}"
        return f"{key}{loc}={val.replace(OLD, NEW)}"
    return _FIELD.sub(sub, text)


def _linux_items(root: Path, home: Path) -> list:
    items = []
    for f in _desktop_files(home):
        try:
            text = f.read_text(encoding="utf-8")
        except Exception:
            continue
        if not _inside(text, root):
            continue
        # Names as they read, and the icon by its file name only: the install's
        # own folder may well be called VibeNode in either case.
        shown = "\n".join(Path(m.group(3)).name if m.group(1) == "Icon" else m.group(3)
                          for m in _FIELD.finditer(text))
        if not _had_old(f.name if f.parent.name == "Desktop" else "", shown):
            continue    # names and icon carry no trace of VibeNode
        new_text = _new_desktop_text(text)
        new_path = f.with_name(_renamed(f.name)) if (f.parent.name == "Desktop" and OLD in f.name) else f
        if new_text == text and new_path == f:
            continue
        where = {"applications": "app menu", "Desktop": "desktop", "autostart": "sign-in start"}[f.parent.name]
        name = re.search(r"^Name=(.*)$", text, re.M)
        items.append({"kind": "linux_desktop", "path": str(f), "new_path": str(new_path),
                      "new_text": new_text,
                      "label": f"{(name.group(1) if name else f.stem)} on the {where}",
                      "becomes": _renamed(name.group(1)) if name else NEW})
    return items


def _apply_linux(item: dict) -> None:
    src, dst = Path(item["path"]), Path(item["new_path"])
    src.write_text(item["new_text"], encoding="utf-8")
    if dst != src and not dst.exists():
        src.rename(dst)
    if dst.parent.name == "Desktop":
        # GNOME shows an edited launcher as an untrusted file until it is trusted again.
        try:
            subprocess.run(["gio", "set", str(dst), "metadata::trusted", "true"],
                           capture_output=True, timeout=5)
        except Exception:
            pass


# ── Linux: background services ───────────────────────────────────────────
# The services this install runs (the phone Start page, the leaked-process
# reaper) describe themselves by name in the service list. Only units whose
# command runs inside this install, and only their Description line.

_DESC = re.compile(r"^Description=(.*)$", re.M)


def _unit_items(root: Path, home: Path) -> list:
    d = home / ".config" / "systemd" / "user"
    items = []
    if not d.is_dir():
        return items
    for f in sorted(d.glob("*.service")):
        try:
            text = f.read_text(encoding="utf-8")
        except Exception:
            continue
        m = _DESC.search(text)
        if not m or OLD not in m.group(1) or not _inside(text, root):
            continue
        new_text = _DESC.sub(lambda x: "Description=" + x.group(1).replace(OLD, NEW), text, count=1)
        items.append({"kind": "linux_unit", "path": str(f), "new_text": new_text,
                      "label": f"Background service: {m.group(1)[:60]}",
                      "becomes": m.group(1).replace(OLD, NEW)[:60]})
    return items


def _apply_unit(item: dict) -> None:
    Path(item["path"]).write_text(item["new_text"], encoding="utf-8")
    try:
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, timeout=10)
    except Exception:
        pass


# ── macOS: .command files and the Applications link ─────────────────────

def _mac_items(root: Path, home: Path) -> list:
    items = []
    desk = home / "Desktop"
    if desk.is_dir():
        for f in sorted(desk.glob("*.command")):
            try:
                text = f.read_text(encoding="utf-8")
            except Exception:
                continue
            if OLD in f.name and (_inside(text, root) or "VibeNode" in text):
                items.append({"kind": "rename", "path": str(f), "new_path": str(f.with_name(_renamed(f.name))),
                              "label": f"{f.stem} on the desktop", "becomes": _renamed(f.stem)})
    app = Path("/Applications") / OLD
    if app.is_symlink() and _inside(os.readlink(app), root):
        items.append({"kind": "rename", "path": str(app), "new_path": str(app.with_name(NEW)),
                      "label": f"{OLD} in Applications", "becomes": NEW})
    return items


# ── Windows: .lnk shortcuts on the desktop and in the Start menu ────────

_PS_READ = (
    "$ws = New-Object -ComObject WScript.Shell;"
    "$out = @();"
    "foreach ($d in ($env:VN_DIRS -split [char]10)) {"
    "  if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }"
    "  foreach ($f in Get-ChildItem -LiteralPath $d -Filter *.lnk -File) {"
    "    $l = $ws.CreateShortcut($f.FullName);"
    "    $out += [pscustomobject]@{path=$f.FullName; target=$l.TargetPath;"
    "      args=$l.Arguments; workdir=$l.WorkingDirectory; icon=$l.IconLocation}"
    "  }"
    "};"
    "ConvertTo-Json -InputObject @($out) -Compress"
)

_PS_ICON = (
    "$ws = New-Object -ComObject WScript.Shell;"
    "$l = $ws.CreateShortcut($env:VN_LNK);"
    "$l.IconLocation = $env:VN_ICON + ',0';"
    "$l.Save()"
)


def _run_ps(script: str, env_extra: dict, timeout: int = 15):
    env = dict(os.environ, **env_extra)
    return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                          capture_output=True, text=True, timeout=timeout, env=env,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _windows_dirs(home: Path) -> list:
    dirs = [home / "Desktop"]
    try:
        from launcher.shortcut_repair import desktop_dirs
        dirs = list(desktop_dirs())
    except Exception:
        pass
    appdata = os.environ.get("APPDATA")
    if appdata:
        dirs.append(Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    return dirs


def _windows_items(root: Path, home: Path) -> list:
    try:
        r = _run_ps(_PS_READ, {"VN_DIRS": "\n".join(str(d) for d in _windows_dirs(home))})
        found = json.loads(r.stdout.strip() or "[]")
    except Exception:
        return []
    if isinstance(found, dict):
        found = [found]
    items = []
    for i in found:
        if not (_inside(i.get("target", ""), root) or _inside(i.get("args", ""), root)
                or _inside(i.get("workdir", ""), root)):
            continue
        p = Path(i["path"])
        icon_file = re.split(r"[\\/]", (i.get("icon") or "").split(",")[0])[-1]
        if not _had_old(p.stem, icon_file):
            continue    # a DevelopNode shortcut, or an icon the person picked
        stop = "stop" in p.stem.lower()
        if stop:
            continue  # Windows has no stop shortcut of ours; leave others alone
        new_path = p.with_name(_renamed(p.name))
        if new_path == p and str(ICON_ICO).lower() in (i.get("icon") or "").lower():
            continue
        where = "desktop" if p.parent.name.lower() != "programs" else "Start menu"
        items.append({"kind": "windows_lnk", "path": str(p), "new_path": str(new_path),
                      "label": f"{p.stem} on the {where}", "becomes": _renamed(p.stem)})
    return items


def _apply_windows(item: dict) -> None:
    _run_ps(_PS_ICON, {"VN_LNK": item["path"], "VN_ICON": str(ICON_ICO)})
    src, dst = Path(item["path"]), Path(item["new_path"])
    if dst != src and not dst.exists():
        src.rename(dst)


# ── the project list ─────────────────────────────────────────────────────

def _project_item(root: Path) -> list:
    try:
        from .config import _load_project_names, _encode_cwd  # noqa: F401
    except Exception:
        return []
    enc = _encode_cwd(str(root))
    names = _load_project_names()
    current = names.get(enc, "")
    if current == NEW or (current and OLD not in current):
        return []   # already renamed, or a name the person chose themselves
    if not current and not _had_old(root.name):
        return []   # shown under its folder's name, which never said VibeNode
    return [{"kind": "project_name", "encoded": enc,
             "label": f"The {current or OLD} project in your project list",
             "becomes": (current.replace(OLD, NEW) if current else NEW)}]


def _apply_project(item: dict) -> None:
    from .config import _load_project_names, _save_project_names
    names = _load_project_names()
    names[item["encoded"]] = item["becomes"]
    _save_project_names(names)


# ── public ───────────────────────────────────────────────────────────────

def scan(root: Path = None, home: Path = None, platform: str = None) -> list:
    """Everything on this computer that still shows the old name."""
    root = Path(root or ROOT)
    home = Path(home or Path.home())
    platform = platform or sys.platform
    items = _project_item(root)
    try:
        if platform == "win32":
            items += _windows_items(root, home)
        elif platform == "darwin":
            items += _mac_items(root, home)
        else:
            items += _linux_items(root, home)
            items += _unit_items(root, home)
    except Exception:
        pass
    for n, it in enumerate(items):
        it["id"] = f"{it['kind']}:{n}"
    return items


def status(root: Path = None, home: Path = None, state_path: Path = None) -> dict:
    st = _read_state(state_path)
    items = scan(root, home)
    if st.get("state") == "done" and not items:
        show = False
    else:
        show = bool(items)
    public = [{"id": i["id"], "label": i["label"], "becomes": i["becomes"]} for i in items]
    return {"show": show, "old": OLD, "new": NEW, "items": public, "state": st.get("state", "")}


_APPLY = {"linux_desktop": _apply_linux, "windows_lnk": _apply_windows,
          "rename": lambda i: (not Path(i["new_path"]).exists()) and Path(i["path"]).rename(i["new_path"]),
          "project_name": _apply_project, "linux_unit": _apply_unit}


def apply(root: Path = None, home: Path = None, state_path: Path = None) -> dict:
    """Rename everything ``scan`` finds; report each one."""
    results = []
    for it in scan(root, home):
        try:
            _APPLY[it["kind"]](it)
            results.append({"label": it["label"], "becomes": it["becomes"], "ok": True})
        except Exception as e:
            results.append({"label": it["label"], "becomes": it["becomes"], "ok": False, "error": str(e)})
    _write_state({"state": "done", "at": time.time(),
                  "failed": [r["label"] for r in results if not r["ok"]]}, state_path)
    return {"ok": all(r["ok"] for r in results), "results": results}

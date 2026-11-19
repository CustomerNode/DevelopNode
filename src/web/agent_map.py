"""The Workflow agent map: where each session is in the codebase.

Workflow mode's Agents view draws the project's folders as tiles and every
session as a dot on the folder it has been working in, with its last steps in
plain words one tap away.  This module reads two things:

- ``recent_activity(path, cwd)``: the files a session touched and the steps
  it took lately, from the tail of its transcript.  Only the tool calls
  (Read, Edit, Write, Grep, Bash, Agent...) are read; the words for each are
  the same plain rules the thread's step lines use
  (``src/web/static/js/work-trail.js``).
- ``project_tree(cwd)``: the project's folders with their file counts, for the
  tiles.  Bounded and cached, so a large repository costs one walk a minute.

Pure file reading, no Flask.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

# How much of a transcript's tail is read for the map.  A turn of a busy
# session is a few hundred KB; this covers the last few turns.
TAIL_BYTES = 768 * 1024
MAX_STEPS = 8
MAX_FILES = 12

_LOOK = {"Read", "NotebookRead"}
_CHANGE = {"Edit", "MultiEdit", "NotebookEdit"}
_WRITE = {"Write"}
_SEARCH = {"Grep", "Glob"}
_WEB = {"WebSearch", "WebFetch"}
_SHELL = {"Bash", "PowerShell"}
_AGENT = {"Agent", "Task"}
_FILE_KEYS = ("file_path", "notebook_path", "path")

# Folders a map never shows: dependencies, caches, the app's own data.
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache",
              ".pytest_cache", "dist", "build", ".idea", ".vscode", "data", "logs", ".cache"}
_TREE_MAX_ENTRIES = 40000
_TREE_TTL_S = 60.0
_tree_cache: dict = {}
_tree_lock = threading.Lock()


def _short(s, n=70):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def rel_path(path: str, cwd: str) -> str:
    """*path* relative to the project folder *cwd* when it lies inside it,
    else the path as given (an absolute path elsewhere stays absolute)."""
    p = str(path or "").replace("\\", "/")
    c = str(cwd or "").replace("\\", "/").rstrip("/")
    if c and (p == c or p.startswith(c + "/")):
        return p[len(c):].lstrip("/")
    return p


def describe_tool(name: str, inp: dict, cwd: str = "") -> dict:
    """One tool call in plain words: ``{verb, obj, file}`` (*file* relative
    to *cwd*, or None when the call touched no file)."""
    inp = inp if isinstance(inp, dict) else {}
    f = next((str(inp[k]) for k in _FILE_KEYS if inp.get(k)), "")
    rf = rel_path(f, cwd) if f else ""
    base = rf.rsplit("/", 1)[-1] if rf else ""
    if name in _LOOK:
        return {"verb": "Read", "obj": base or "a file", "file": rf or None}
    if name in _CHANGE:
        return {"verb": "Changed", "obj": base or "a file", "file": rf or None}
    if name in _WRITE:
        return {"verb": "Wrote", "obj": base or "a file", "file": rf or None}
    if name in _SEARCH:
        return {"verb": "Searched for", "obj": _short(inp.get("pattern") or inp.get("query") or ""), "file": None}
    if name in _WEB:
        return {"verb": "Searched the web for", "obj": _short(inp.get("query") or inp.get("url") or ""), "file": None}
    if name in _SHELL:
        return {"verb": "Ran", "obj": _short(inp.get("description") or inp.get("command") or ""), "file": None}
    if name in _AGENT:
        return {"verb": "Asked a helper:", "obj": _short(inp.get("description") or inp.get("prompt") or ""), "file": None}
    return {"verb": "Used", "obj": _short(name), "file": None}


def _iso_to_epoch(s) -> float:
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def recent_activity(path: Path, cwd: str = "", tail_bytes: int = TAIL_BYTES) -> dict:
    """``{files, steps, last_ts}`` for the session whose transcript is *path*:
    the files it touched lately (newest first, unique, relative to *cwd*), its
    last ``MAX_STEPS`` tool calls in plain words (newest first, each
    ``{verb, obj, file, ts}``) and the time of the newest one."""
    out = {"files": [], "steps": [], "last_ts": 0.0}
    try:
        size = path.stat().st_size
        with open(path, "rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
                fh.readline()      # the first line is probably cut
            raw = fh.read()
    except OSError:
        return out
    steps = []
    for line in raw.decode("utf-8", "replace").splitlines():
        if '"tool_use"' not in line or '"assistant"' not in line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if obj.get("type") != "assistant" or obj.get("isSidechain"):
            continue
        ts = _iso_to_epoch(obj.get("timestamp"))
        content = (obj.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                d = describe_tool(str(b.get("name") or ""), b.get("input"), cwd)
                d["ts"] = ts
                steps.append(d)
    steps.reverse()
    files = []
    for s in steps:
        if s["file"] and s["file"] not in files:
            files.append(s["file"])
    out["files"] = files[:MAX_FILES]
    out["steps"] = steps[:MAX_STEPS]
    out["last_ts"] = steps[0]["ts"] if steps else 0.0
    return out


def folders_of(files: list) -> dict:
    """How many of *files* sit in each folder (the file's own folder; the
    project root is ``"."``)."""
    out: dict = {}
    for f in files:
        folder = f.rsplit("/", 1)[0] if "/" in f else "."
        out[folder] = out.get(folder, 0) + 1
    return out


def project_tree(cwd: str, depth: int = 2, max_entries: int = _TREE_MAX_ENTRIES) -> list:
    """The project's folders to *depth* with their file counts (files in the
    folder and below), as ``[{path, files}]`` sorted by count, biggest
    first; ``"."`` is the root's own files.  Skips dependencies, caches and
    the app's data folders; stops counting after *max_entries* entries so a
    huge tree costs a bounded walk.  Cached for a minute per folder."""
    root = Path(cwd) if cwd else None
    if not root or not root.is_dir():
        return []
    key = str(root)
    now = time.time()
    with _tree_lock:
        hit = _tree_cache.get(key)
        if hit and now - hit[0] < _TREE_TTL_S:
            return hit[1]
    counts: dict = {}
    seen = 0

    def walk(d: Path, rel: str, level: int):
        nonlocal seen
        try:
            entries = list(os.scandir(d))
        except OSError:
            return
        for e in entries:
            seen += 1
            if seen > max_entries:
                return
            name = e.name
            if name.startswith(".") or name in _SKIP_DIRS:
                continue
            try:
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                sub = f"{rel}/{name}" if rel else name
                if level < depth:
                    walk(Path(e.path), sub, level + 1)
                else:
                    counts[sub] = counts.get(sub, 0) + _count_files(Path(e.path), max_entries)
            else:
                counts[rel or "."] = counts.get(rel or ".", 0) + 1

    walk(root, "", 1)
    # A folder's count includes its subfolders', so a tile says how much is under it.
    totals: dict = {}
    for p, n in counts.items():
        parts = [] if p == "." else p.split("/")
        totals["."] = totals.get(".", 0) + (n if p == "." else 0)
        for i in range(1, len(parts) + 1):
            k = "/".join(parts[:i])
            totals[k] = totals.get(k, 0) + n
    tree = [{"path": p, "files": n} for p, n in totals.items() if n > 0]
    tree.sort(key=lambda t: (-t["files"], t["path"]))
    with _tree_lock:
        _tree_cache[key] = (now, tree)
    return tree


def _count_files(d: Path, budget: int) -> int:
    n = 0
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x not in _SKIP_DIRS]
        n += len(files)
        if n > budget:
            break
    return n

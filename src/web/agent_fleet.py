"""Where agents are, across every project.

For each project: the sessions that are working or were active lately, the
helpers (subagents) each one launched, the files each touched (newest first),
the edits each made to those files and its last few messages.  Everything is
read from the tail of the transcripts the CLI writes, so nothing is asked of
the Session Engine.  Also the real contents of a project folder and the start
of a file, for the tree the page draws.

Reads are confined to a project's own folder: a path is resolved (symlinks
included) and refused unless it stays inside the project root, because the
routes that call this are reachable from every device that can reach the app.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from . import agent_map

TAIL_BYTES = 1024 * 1024
MAX_FILES = 12          # per agent or helper
MAX_EDITS = 4           # per file, newest kept
MAX_EDIT_CHARS = 1600
MAX_CHAT = 5
MAX_CHAT_CHARS = 700
MAX_HELPERS = 10
MAX_AGENTS = 14         # per project
HELPER_LIVE_S = 300     # a helper that has not finished and wrote this recently counts as working
FILE_MAX_BYTES = 512 * 1024
FILE_MAX_LINES = 600
FILE_MAX_COLS = 300
DIR_MAX_FOLDERS = 60
DIR_MAX_FILES = 80
DIR_BUDGET = 1500       # entries one listing call may return
DIR_MAX_DEPTH = 4

_EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache",
              ".pytest_cache", "dist", "build", ".next", "chrome-profile", ".idea", ".vscode"}
# Text injected into a transcript that is not something a person or the agent said.
_NOT_SPEECH = ("<", "[VibeNode", "Stop hook feedback", "⟦")

_cache: dict = {}
_CACHE_MAX = 600


def _clip(s, n: int) -> str:
    s = s if isinstance(s, str) else ""
    return s if len(s) <= n else s[:n] + "\n…"


def _texts(content) -> list:
    if isinstance(content, str):
        return [content]
    out = []
    for b in content if isinstance(content, list) else []:
        if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
            out.append(b["text"])
    return out


def inside_project(rel: str) -> bool:
    """True for a path ``agent_map.rel_path`` made relative to the project root."""
    return bool(rel) and not rel.startswith(("/", "~", "..")) and ":" not in rel


def activity(path: Path, cwd: str, sidechain: bool) -> dict:
    """``{files, steps, last_ts, edits, chat}`` from the tail of one transcript.

    *sidechain* picks which lines count: a helper's own transcript marks every
    line as a sidechain, a session's transcript marks none of its own.  Cached
    per file version (size and modification time), so a refresh re-reads only
    transcripts that grew.
    """
    empty = {"files": [], "steps": [], "last_ts": 0.0, "edits": {}, "chat": []}
    try:
        st = path.stat()
    except OSError:
        return empty
    key = (str(path), st.st_mtime_ns, st.st_size, cwd, sidechain)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    try:
        with open(path, "rb") as fh:
            if st.st_size > TAIL_BYTES:
                fh.seek(st.st_size - TAIL_BYTES)
                fh.readline()      # the first line is probably cut
            raw = fh.read()
    except OSError:
        return empty
    steps, chat, edits = [], [], {}
    for line in raw.decode("utf-8", "replace").splitlines():
        if '"assistant"' not in line and '"user"' not in line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        typ = obj.get("type")
        if typ not in ("assistant", "user") or bool(obj.get("isSidechain")) != sidechain or obj.get("isMeta"):
            continue
        content = (obj.get("message") or {}).get("content")
        ts = agent_map._iso_to_epoch(obj.get("timestamp"))
        for t in _texts(content):
            t = t.strip()
            if t and not t.startswith(_NOT_SPEECH) and not t.startswith("```handoff"):
                chat.append({"r": "a" if typ == "assistant" else "u", "t": _clip(t, MAX_CHAT_CHARS), "ts": ts})
        if typ != "assistant" or not isinstance(content, list):
            continue
        for b in content:
            if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                continue
            name = str(b.get("name") or "")
            inp = b.get("input") if isinstance(b.get("input"), dict) else {}
            d = agent_map.describe_tool(name, inp, cwd)
            d["ts"] = ts
            steps.append(d)
            if name not in _EDIT_TOOLS or not d.get("file"):
                continue
            rows = inp.get("edits") if name == "MultiEdit" and isinstance(inp.get("edits"), list) else [inp]
            for e in rows:
                if not isinstance(e, dict):
                    continue
                if name == "Write":
                    row = {"old": "", "new": _clip(e.get("content"), MAX_EDIT_CHARS), "whole": True, "ts": ts}
                else:
                    row = {"old": _clip(e.get("old_string"), MAX_EDIT_CHARS),
                           "new": _clip(e.get("new_string") or e.get("new_source"), MAX_EDIT_CHARS), "ts": ts}
                edits.setdefault(d["file"], []).append(row)
    steps.reverse()
    files = []
    for s in steps:
        f = s.get("file")
        if f and inside_project(f) and f not in files:
            files.append(f)
    files = files[:MAX_FILES]
    out = {
        "files": files,
        "steps": [{"verb": s.get("verb"), "obj": s.get("obj"), "file": s.get("file"), "ts": s.get("ts")}
                  for s in steps[:agent_map.MAX_STEPS]],
        "last_ts": steps[0]["ts"] if steps else 0.0,
        "edits": {f: v[-MAX_EDITS:] for f, v in edits.items() if f in files},
        "chat": chat[-MAX_CHAT:],
    }
    if len(_cache) >= _CACHE_MAX:
        _cache.clear()
    _cache[key] = out
    return out


def helpers_of(session_dir: Path, cwd: str, now: float) -> list:
    """The helpers one session launched, newest first: the CLI keeps each in
    ``<session id>/subagents/agent-<id>.jsonl`` with a ``.meta.json`` beside it."""
    d = session_dir / "subagents"
    out = []
    try:
        metas = sorted(d.glob("agent-*.meta.json"))
    except OSError:
        return out
    for meta in metas:
        try:
            m = json.loads(meta.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        aid = meta.name[len("agent-"):-len(".meta.json")]
        tr = meta.with_name(f"agent-{aid}.jsonl")
        try:
            mtime = tr.stat().st_mtime
        except OSError:
            mtime = 0.0
        a = dict(activity(tr, cwd, True))
        a.update({"id": aid, "name": str(m.get("description") or m.get("agentType") or "Helper"),
                  "parent": str(m.get("parentAgentId") or ""),
                  "live": (not m.get("finished")) and now - mtime < HELPER_LIVE_S,
                  "last_ts": a["last_ts"] or mtime})
        out.append(a)
    out.sort(key=lambda h: -h["last_ts"])
    return out[:MAX_HELPERS]


def project_agents(sessions_dir: Path, cwd: str, row_of, live: set, hours: float, now: float) -> list:
    """The agents of one project: every session that is working, or whose
    transcript changed in the last *hours*.  *row_of(path)* returns a
    session's listing row (title, next step) and is asked only for the few
    sessions that are shown: summarising every transcript of a large project
    took most of a minute on a cold start.  *live* holds the ids working now."""
    cands = []
    try:
        entries = list(os.scandir(sessions_dir))
    except OSError:
        return []
    for e in entries:
        if not e.name.endswith(".jsonl"):
            continue
        sid = e.name[:-len(".jsonl")]
        try:
            mtime = e.stat().st_mtime
        except OSError:
            continue
        if sid in live or now - mtime < hours * 3600:
            cands.append((sid in live, mtime, sid, Path(e.path)))
    cands.sort(key=lambda c: (not c[0], -c[1]))
    out = []
    for is_live, mtime, sid, path in cands[:MAX_AGENTS]:
        a = dict(activity(path, cwd, False))
        hs = helpers_of(sessions_dir / sid, cwd, now)
        if not a["files"] and not hs and not is_live:
            continue
        try:
            row = row_of(path) or {}
        except Exception:       # a name is not worth losing the agent over
            row = {}
        step = row.get("next_step") or {}
        a.update({"id": sid, "name": row.get("custom_title") or row.get("display_title") or "Untitled session",
                  "live": is_live, "group": "working" if is_live else str(step.get("group") or "done"),
                  "last_ts": a["last_ts"] or mtime, "helpers": hs})
        out.append(a)
    out.sort(key=lambda a: (not a["live"], -a["last_ts"]))
    return out


def _within(root: Path, rel: str) -> Path | None:
    """*rel* inside *root*, resolved; None when it leaves the project folder."""
    try:
        base = root.resolve()
        target = (base / rel).resolve() if rel else base
        target.relative_to(base)
    except (OSError, ValueError):
        return None
    return target


def listing(cwd: str, rel: str = "", depth: int = 1) -> dict | None:
    """``{folder: {d: [folders], f: [files], more: n}}`` for *rel* and the
    folders below it, *depth* levels down (at most ``DIR_MAX_DEPTH``), stopping
    once ``DIR_BUDGET`` names were returned.  None when *rel* is not a folder
    inside the project."""
    rel = rel.strip("/").replace("\\", "/")
    base = _within(Path(cwd), rel)
    if base is None or not base.is_dir():
        return None
    depth = max(1, min(int(depth), DIR_MAX_DEPTH))
    out, budget = {}, [DIR_BUDGET]

    def scan(r: str, level: int) -> None:
        target = _within(Path(cwd), r)
        if target is None or budget[0] <= 0:
            return
        try:
            ents = sorted(os.scandir(target), key=lambda e: e.name.lower())
        except OSError:
            return
        dirs, files = [], []
        for e in ents:
            try:
                is_dir = e.is_dir()
            except OSError:
                continue
            if is_dir:
                if e.name not in _SKIP_DIRS:
                    dirs.append(e.name)
            else:
                files.append(e.name)
        out[r] = {"d": dirs[:DIR_MAX_FOLDERS], "f": files[:DIR_MAX_FILES],
                  "more": max(0, len(dirs) - DIR_MAX_FOLDERS) + max(0, len(files) - DIR_MAX_FILES)}
        budget[0] -= len(out[r]["d"]) + len(out[r]["f"])
        if level < depth:
            for name in out[r]["d"]:
                scan(f"{r}/{name}" if r else name, level + 1)

    scan(rel, 1)
    return out


def file_text(cwd: str, rel: str) -> dict:
    """The start of a text file inside the project: ``{kind, text, total}``.
    ``kind`` is ``text``, ``missing``, ``big`` or ``binary``."""
    target = _within(Path(cwd), rel.strip("/").replace("\\", "/"))
    if target is None or not target.is_file():
        return {"kind": "missing"}
    try:
        if target.stat().st_size > FILE_MAX_BYTES:
            return {"kind": "big"}
        text = target.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        return {"kind": "binary"}
    except OSError:
        return {"kind": "missing"}
    if "\x00" in text:
        return {"kind": "binary"}
    lines = text.splitlines()
    return {"kind": "text", "total": len(lines),
            "text": "\n".join(line[:FILE_MAX_COLS] for line in lines[:FILE_MAX_LINES])}


def now() -> float:
    return time.time()

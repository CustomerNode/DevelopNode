"""Routes for "Where agents are" (``src/web/agent_fleet.py``, drawn by
``static/js/agent-fleet.js``): the agents of every project, and the folders and
files of a project for the tree."""
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request

from .. import agent_fleet
from ..config import _CLAUDE_PROJECTS
from ..session_awareness import _get_all_states_cached
from ..sessions import load_session_summary
from .project_api import api_projects

bp = Blueprint("fleet", __name__)

_LIVE = ("working", "starting")


def _projects() -> list:
    """The projects the picker lists (``GET /api/projects``): the one list of
    folders these routes may read."""
    return api_projects().get_json() or []


def _cwd_of(encoded: str) -> str:
    for p in _projects():
        if p.get("encoded") == encoded:
            return str(p.get("display") or "")
    return ""


def _live_ids() -> set:
    sm = current_app.session_manager
    try:
        states = sm.get_all_states() if current_app.testing else _get_all_states_cached(sm)
    except Exception:       # the page still shows recent agents when the Session Engine is away
        states = []
    out = set()
    for s in states or []:
        if isinstance(s, dict) and s.get("state") in _LIVE and s.get("session_type") not in ("planner", "title"):
            out.add(str(s.get("session_id") or ""))
    return out


@bp.route("/api/agent-fleet")
def api_agent_fleet():
    """Every project's agents: working now, or active in the last ``hours``
    (default 72, at most 336).  Each agent carries its helpers, the files it
    touched, its edits to them and its last messages."""
    try:
        hours = max(1.0, min(float(request.args.get("hours", 72)), 336.0))
    except ValueError:
        hours = 72.0
    now, live, out = agent_fleet.now(), _live_ids(), []
    for p in _projects():
        enc, cwd = str(p.get("encoded") or ""), str(p.get("display") or "")
        if not enc or not cwd:
            continue
        agents = agent_fleet.project_agents(Path(_CLAUDE_PROJECTS) / enc, cwd, load_session_summary, live, hours, now)
        if agents:
            out.append({"id": enc, "name": p.get("custom_name") or Path(cwd).name, "cwd": cwd, "agents": agents})
    return jsonify({"at": now, "hours": hours, "projects": out})


@bp.route("/api/agent-fleet/dirs")
def api_agent_fleet_dirs():
    """The real contents of a project folder: ``project`` (encoded), ``path``
    (relative, empty for the root) and ``depth`` (levels below it, 1 to 4)."""
    cwd = _cwd_of(request.args.get("project", ""))
    if not cwd:
        return jsonify({"ok": False, "error": "unknown project"}), 404
    try:
        depth = int(request.args.get("depth", 1))
    except ValueError:
        depth = 1
    dirs = agent_fleet.listing(cwd, request.args.get("path", ""), depth)
    if dirs is None:
        return jsonify({"ok": False, "error": "not a folder in this project"}), 404
    return jsonify({"ok": True, "dirs": dirs})


@bp.route("/api/agent-fleet/file")
def api_agent_fleet_file():
    """The start of one text file of a project: ``project`` (encoded) and
    ``path`` (relative).  ``kind`` says why there is no text."""
    cwd = _cwd_of(request.args.get("project", ""))
    if not cwd:
        return jsonify({"ok": False, "error": "unknown project"}), 404
    return jsonify({"ok": True, **agent_fleet.file_text(cwd, request.args.get("path", ""))})

"""The Workflow queue: top-level tasks in priority order, their status read
off their sessions' summary cards.

Workflow mode's Queue view is one ordered list of the project's top-level
tasks.  A task has one orchestrator session and at most one level of
children, its subsessions; nothing is typed into a status field.  A task's
status is the most urgent of its sessions' verbs and its children's
(``src/web/feed.py`` holds the verbs and their order), ``Not started`` when
none of them has a session yet, ``Done`` when the person marked the task
complete and nothing runs.

The order is the person's: a saved list of task ids per project
(``data/queue_order/<project>.json``), top first; tasks not in it follow in
their board position.  Groups stay fixed above that order: Needs you,
Working, Not started, Standby, Done.

Also the orchestrator contract: the text given to a task's one session so it
knows when to open a subsession (a part that will need the person) and when
a subagent is enough.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from shared.paths import DATA_DIR

from . import feed as _feed

GROUP_RANK = {"needs": 0, "working": 1, "new": 2, "standby": 3, "done": 4}
LABEL = dict(_feed.LABEL, new="Not started")

_ORDER_DIR = DATA_DIR / "queue_order"
_PROJECT_OK = re.compile(r"^[A-Za-z0-9._-]{1,255}$")


def task_verb(own_verbs, child_verbs, old_status: str | None) -> str:
    """The verb a task shows: the most urgent among its own sessions' and
    its children's; with none, ``done`` for a task marked complete, else
    ``new`` (not started)."""
    verbs = [v for v in list(own_verbs) + list(child_verbs) if v and v in _feed.RANK]
    if verbs:
        return min(verbs, key=lambda v: _feed.RANK[v])
    return "done" if str(old_status or "") == "complete" else "new"


def group_of(verb: str) -> str:
    return "new" if verb == "new" else _feed.GROUP.get(verb, "done")


def _session_row(it: dict) -> dict:
    return {"session_id": it.get("session_id"), "verb": it.get("verb"), "group": it.get("group"),
            "label": it.get("label"), "title": it.get("title"), "headline": it.get("headline"),
            "eta_minutes": it.get("eta_minutes"), "ts": it.get("ts") or 0, "card": it.get("card")}


def _task_row(t: dict, kids: list, sessions: dict, items: dict) -> dict:
    own = [items[s] for s in sessions.get(t["id"], []) if s in items]
    own.sort(key=lambda it: (_feed.RANK.get(it.get("verb"), 99), -(it.get("ts") or 0)))
    kid_rows = [_task_row(k, [], sessions, items) for k in kids]
    verb = task_verb([it.get("verb") for it in own], [k["verb"] for k in kid_rows], t.get("status"))
    most = own[0] if own else None
    return {
        "id": t["id"], "title": t.get("title") or "", "verb": verb, "group": group_of(verb), "label": LABEL.get(verb, verb),
        "old_status": t.get("status"), "position": t.get("position") or 0,
        "latest": (most.get("headline") or most.get("line") or "") if most else "",
        "sessions": [_session_row(it) for it in own],
        "children": kid_rows,
        "children_done": sum(1 for k in kid_rows if k["group"] == "done"),
        "has_session": bool(own) or any(k["sessions"] for k in kid_rows),
    }


def build(tasks: list, children: dict, sessions: dict, items: dict, order: list) -> list:
    """The queue rows.  *tasks*: top-level task dicts in board position
    order; *children*: parent id -> its child task dicts; *sessions*: task
    id -> the session ids linked to it; *items*: session id -> its feed
    item; *order*: the saved task-id order."""
    rows = [_task_row(t, children.get(t["id"], []), sessions, items) for t in tasks]
    pos = {tid: i for i, tid in enumerate(order)}
    rows.sort(key=lambda r: (GROUP_RANK.get(r["group"], 9), pos.get(r["id"], 10 ** 9), r["position"]))
    return rows


def unfiled(items: dict, filed: set) -> list:
    """Feed items of sessions no task owns, in feed order."""
    out = [_session_row(it) for sid, it in items.items() if sid not in filed]
    out.sort(key=lambda r: (_feed.RANK.get(r["verb"], 99), -(r["ts"] or 0)))
    return out


# ── The person's order ────────────────────────────────────────────────────

def _order_path(project: str) -> Path | None:
    if not project or not _PROJECT_OK.match(project):
        return None
    return _ORDER_DIR / f"{project}.json"


def load_order(project: str) -> list:
    p = _order_path(project)
    if p is None or not p.is_file():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    ids = d.get("ids") if isinstance(d, dict) else None
    return [str(x) for x in ids] if isinstance(ids, list) else []


def save_order(project: str, ids: list) -> bool:
    p = _order_path(project)
    if p is None:
        return False
    clean = []
    for x in ids:
        s = str(x).strip()
        if s and s not in clean and len(s) <= 64:
            clean.append(s)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"ids": clean}, indent=1), encoding="utf-8")
    tmp.replace(p)
    return True


# ── The orchestrator contract ─────────────────────────────────────────────

ORCHESTRATOR_CONTRACT = """## You are this task's orchestrator

Task id: {task_id}. You are the one session for this task in DevelopNode's Workflow queue. The task's status is read from your end-of-turn summary cards and your subsessions'; nobody types it.

Split the work into parts and, for each part, decide which kind it is:

- A SUBSESSION when the part will need the person at some point: a pick between options, a review of what was built, a design, a sign-off, a draft to send. It gets its own task row under yours, its own session and its own summary card in the person's feed. Open it with one request from your shell (the body is JSON; put everything the part needs to know in "prompt"):

    curl -s -X POST "http://127.0.0.1:5050/api/queue/tasks/{task_id}/subsessions" -H "Content-Type: application/json" -d '{{"title": "<the part, a few words>", "prompt": "<what to do>", "parent_session_id": "{session_id}"}}'

  It answers with the new task id and session id. A subsession reports back to you when it ends a turn; its report is put in front of your next message. Open at most one level: a subsession never opens subsessions of its own.

- A SUBAGENT (the Agent tool) when the part will not need the person. It runs inside this session and never gets a card.

Keep your own summary card about the whole task: which parts are done, which wait on the person, what still runs. Done on the task is the person's verdict, never yours: never mark the task complete yourself. End every turn on your summary card."""

SUBSESSION_BRIEF = """## You are a subsession of this task

Parent task id: {parent_task_id}; your part: "{title}". Do this part and nothing else. When it needs the person (a pick, a review, a sign-off), ask on your summary card and end the turn; the person answers on it. When you reach a conclusion, end your message with a short summary the orchestrator can act on and, on the line after it, the marker `<!-- subsession:report -->` so it reaches the orchestrator's inbox. Never open subsessions of your own."""


def orchestrator_prompt(task_id: str, session_id: str) -> str:
    return ORCHESTRATOR_CONTRACT.format(task_id=task_id, session_id=session_id or "<your session id>")


def subsession_brief(parent_task_id: str, title: str) -> str:
    return SUBSESSION_BRIEF.format(parent_task_id=parent_task_id, title=str(title or "").replace('"', "'"))

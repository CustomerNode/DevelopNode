"""Per-project status counts for the project picker.

With Smart termination on, the picker shows three columns per project:
Needs you, Standby and Working (Done is left out: it asks nothing of the
person).  The rule is the server twin of ``display()`` / ``shown()`` in
``src/web/static/js/session-verb.js``, reduced to what can be known without a
browser:

- live engine state first: a permission prompt is Needs you, a running turn,
  an armed retry or a pending wake-up (when the summary does not hand the
  move to the person) is Working;
- then the person's hold (``session_holds``): Done is not counted, Standby is;
- then the session's last summary card (``next_step``): Waiting is Working,
  every other verb is Needs you;
- a session with no summary that never replied is New, not counted; any
  other session without a verdict is Needs you, as the sidebar draws it.

Listing every project reads every transcript once (the summary cache in
``src/web/sessions.py`` keeps it after that), so the picker asks for this
separately and draws its rows first.
"""

from __future__ import annotations

from pathlib import Path

GROUPS = ("needs", "standby", "working")
_PERSON_MOVE = {"decide", "unblock", "review", "read", "send"}


def group_of(summary: dict, state: dict | None) -> str | None:
    """'needs' | 'standby' | 'working', or None for Done and New."""
    st = (state or {}).get("state") or ""
    if st == "waiting":
        return "needs"
    if st in ("working", "starting"):
        return "working"
    if st == "idle" and float((state or {}).get("retry_at") or 0) > 0:
        return "working"
    hold = summary.get("hold")
    if hold == "done":
        return None
    if hold == "standby":
        return "standby"
    step = summary.get("next_step") if isinstance(summary.get("next_step"), dict) else {}
    verb = step.get("verb")
    if (state or {}).get("substatus") == "auto-resuming" and verb not in _PERSON_MOVE:
        return "working"
    if verb == "waiting":
        return "working"
    if verb:
        return "needs"
    if not summary.get("message_count"):
        return None                      # New: nothing sent yet
    return "needs"


def project_counts(project: str, states: list, sessions_dir: Path) -> dict:
    """``{"needs": n, "standby": n, "working": n}`` for one project.

    *states* are the engine's states for THIS project's sessions only."""
    from .sessions import all_sessions
    from .session_store import _load_remaps_cached
    from . import session_holds

    rows = all_sessions(summary_only=True, project=project)
    # Holds are saved under the id the browser shows; a transcript still
    # under its launch id must find them (as /api/sessions does).
    aliases = {old: e.get("new_id") for old, e in _load_remaps_cached(project).items()
               if isinstance(e, dict) and e.get("new_id")}
    if aliases:
        for r in rows:
            if r.get("id") in aliases:
                r["id"] = aliases[r["id"]]
        session_holds.overlay(rows, sessions_dir)
    by_sid = {s.get("session_id"): s for s in states if s.get("session_id")}
    out = {g: 0 for g in GROUPS}
    seen = set()
    for r in rows:
        sid = r.get("id")
        if sid in seen:
            continue
        seen.add(sid)
        g = group_of(r, by_sid.get(sid))
        if g:
            out[g] += 1
    # A live session with no transcript yet (its first turn is running).
    for sid, s in by_sid.items():
        if sid not in seen and s.get("state") not in ("stopped", None, ""):
            g = group_of({}, s)
            if g:
                out[g] += 1
    return out

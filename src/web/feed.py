"""The Workflow feed: one line per session, the newest summary card behind it.

Workflow mode lists the person's sessions by their latest summary
(Smart termination's fenced ``handoff`` block), sessions that need the
person at the top.  This module turns the session rows
``GET /api/sessions`` already builds, the engine's live states and the
cached cards (``web.sessions.session_card``) into the feed's items, in
the order the person reads them.

The verb for a session is the same one the sidebar draws
(``src/web/static/js/session-verb.js`` ``display``): live state first, then
the person's own hold, then the card.  Mirrored here rather than computed
in the browser so the feed can be one request on a phone.

Pure: no I/O, no Flask.
"""

from __future__ import annotations

from shared.handoff_status import card_line, verb_from_card

# Reading order: can't-go-on first (a pick, a blocker, a permission), then
# the person's verdict (review, read, send), then what runs by itself, then
# Standby and Done.  The same order as the sidebar's "Active first".
ORDER = ("decide", "unblock", "approve", "review", "read", "send",
         "working", "waiting", "standby", "done")
RANK = {v: i for i, v in enumerate(ORDER)}

GROUP = {"decide": "needs", "unblock": "needs", "approve": "needs", "review": "needs",
         "read": "needs", "send": "needs", "working": "working", "waiting": "working",
         "standby": "standby", "done": "done"}

LABEL = {"decide": "Decide", "unblock": "Unblock", "approve": "Approve", "review": "Review",
         "read": "Read", "send": "Send", "working": "Working", "waiting": "Waiting",
         "standby": "Standby", "done": "Done"}


def verb_for(live_state: str | None, hold: str | None, card: dict | None) -> str | None:
    """The verb to draw for one session, or None when the session has
    nothing for the feed (no card and nothing running).

    Live state wins (a running turn is Working, an open permission is
    Approve); then the person's own hold (Done, Standby); then the card's
    verb.  A card whose verb is ``waiting`` reads as Waiting.
    """
    s = (live_state or "").lower()
    if s in ("working", "starting"):
        return "working"
    if s.startswith("waiting") or s == "question":
        return "approve"
    if hold == "done":
        return "done"
    if hold == "standby":
        return "standby"
    v = verb_from_card(card) if isinstance(card, dict) else None
    if v in ("decide", "unblock", "waiting", "read", "send"):
        return v
    if v == "review":
        return "review"
    return None


def _eta_minutes(card: dict | None) -> int | None:
    needs = card.get("needs") if isinstance(card, dict) and isinstance(card.get("needs"), dict) else {}
    try:
        n = int(needs.get("eta_minutes"))
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def item_for(row: dict, live_state: str | None, card: dict | None) -> dict | None:
    """One feed item for a session row, or None when it has nothing to show."""
    verb = verb_for(live_state, row.get("hold"), card)
    if verb is None:
        return None
    title = ""
    headline = ""
    if isinstance(card, dict):
        title = str(card.get("title") or "")
        headline = str(card.get("headline") or "")
    return {
        "session_id": row.get("id", ""),
        "name": row.get("custom_title") or row.get("display_title") or row.get("id", ""),
        "title": title or (row.get("custom_title") or row.get("display_title") or ""),
        "headline": headline,
        "line": card_line(card) if isinstance(card, dict) else "",
        "verb": verb,
        "group": GROUP[verb],
        "label": LABEL[verb],
        "eta_minutes": _eta_minutes(card) if verb in ("working", "waiting") else None,
        "state": (live_state or "").lower() or None,
        "hold": row.get("hold"),
        "ts": row.get("last_activity_ts") or row.get("effective_ts") or 0,
        "card": card if isinstance(card, dict) else None,
    }


def build(rows: list, states: dict, cards: dict) -> list:
    """The feed: items for every row that has something to show, in reading
    order (verb rank, then newest first).  *states* maps session id to the
    engine's state record (or a bare state string); *cards* maps session id
    to its newest card."""
    out = []
    for row in rows:
        sid = row.get("id", "")
        st = states.get(sid)
        live = st.get("state") if isinstance(st, dict) else st
        it = item_for(row, live, cards.get(sid))
        if it is not None:
            out.append(it)
    out.sort(key=lambda it: (RANK.get(it["verb"], 99), -(it["ts"] or 0)))
    return out

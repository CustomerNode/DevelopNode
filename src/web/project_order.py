"""The order of the project list.

By default projects are listed by their name: the name the person gave the
project, else the project's own folder name, compared without case and with
numbers in numeric order ("Site 2" before "Site 10").  The folder path is never
the key: a project called "Zeta" in ~/Documents must not sort before "Alpha"
in ~/work because of where it lives.

Dragging a project in the picker saves the whole order
(``_project_order.json`` beside the project names, in Claude's projects
folder).  A saved order wins.  A project the saved order does not know yet (a
new one) goes after the ordered ones, by name; one a friend phoned you about
goes first, as it does without an order.
"""

import json
import re

from .config import _CLAUDE_PROJECTS

_ORDER_FILE = _CLAUDE_PROJECTS / "_project_order.json"
_MAX_ORDER = 2000


def project_name(row: dict) -> str:
    """The name the picker shows for a project, minus the parent folder:
    the custom name, else the last folder of its path."""
    custom = (row.get("custom_name") or "").strip()
    if custom:
        return custom
    parts = [p for p in re.split(r"[\\/]", row.get("display") or "") if p]
    return parts[-1] if parts else (row.get("encoded") or "")


def name_key(row: dict):
    """Case-blind, numbers compared as numbers; the path breaks ties."""
    name = project_name(row).casefold()
    chunks = tuple((0, int(c), "") if c.isdigit() else (1, 0, c)
                   for c in re.split(r"(\d+)", name) if c)
    return (chunks, (row.get("display") or "").casefold())


def load_order() -> list:
    try:
        data = json.loads(_ORDER_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    order = data.get("order") if isinstance(data, dict) else data
    return [x for x in order if isinstance(x, str)] if isinstance(order, list) else []


def save_order(order: list) -> list:
    """Save ``order`` (encoded project ids, first on top).  Returns what was
    saved: strings only, no repeats, at most ``_MAX_ORDER``."""
    seen, clean = set(), []
    for x in order or []:
        if isinstance(x, str) and x and x not in seen and "/" not in x and "\\" not in x:
            seen.add(x)
            clean.append(x)
    clean = clean[:_MAX_ORDER]
    if clean:
        _ORDER_FILE.write_text(json.dumps({"order": clean}, indent=2), encoding="utf-8")
    else:
        try:
            _ORDER_FILE.unlink()
        except FileNotFoundError:
            pass
    return clean


def sort_projects(rows: list, order: list | None = None) -> list:
    """``rows`` in list order: phoned projects not in the saved order, then
    the saved order, then the rest by name."""
    order = load_order() if order is None else order
    rank = {enc: i for i, enc in enumerate(order)}

    def key(r):
        enc = r.get("encoded")
        if enc in rank:
            return (1, rank[enc], name_key(r))
        if r.get("phoned"):
            return (0, 0, name_key(r))
        return (2, 0, name_key(r))

    out = sorted(rows, key=key)
    for r in out:
        if r.get("encoded") in rank:
            r["ordered"] = True   # the picker shows "Your order · Sort by name"
    return out

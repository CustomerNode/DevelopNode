"""What an Update brings in and what a Publish sends out, in plain words.

The Update / Publish / Sync dialogs (static/js/git-sync.js) list the parts of
the app a change touches.  Commit titles are generated from folder names
("Update web/static, tests (3 files)"), so the list is built from the changed
files instead: each file belongs to the first area in ``AREAS`` whose prefix
it starts with.  A commit title someone wrote by hand is kept as a note.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .platform_utils import NO_WINDOW as _NO_WINDOW

# (path prefixes, name, what it is).  First match wins, so specific ones first.
AREAS = [
    (("src/web/static/js/last-card", "src/web/static/css/last-card", "src/web/static/js/work-trail",
      "src/web/static/css/work-trail"), "Summary cards", "the end-of-turn summaries"),
    (("src/engine/handoff", "src/engine/smart_termination", "src/engine/stop_plugins",
      "src/shared/handoff"), "Summary checks", "what a summary must have before it is sent"),
    (("src/web/static/js/git-sync", "src/web/git_", "src/web/routes/git_api", "src/web/change_areas",
      "src/web/gate_reuse", "src/web/requirements_sync"), "Update and publish", "these dialogs and the publish checks"),
    (("src/web/static/js/session", "src/web/static/css/session", "src/web/routes/sessions_api",
      "src/web/session"), "Session list", "the sidebar and its statuses"),
    (("src/web/static/js/live-panel", "src/web/static/js/thread-scroll", "src/web/static/js/markdown",
      "src/web/static/js/smart-copy", "src/web/static/js/image-attach"), "Chat", "the conversation and the text box"),
    (("src/web/static/css/", "src/web/static/style.css", "src/web/templates/"), "Look and layout",
     "styles, pages and the phone layout"),
    (("src/web/static/",), "Web app", "other screens in the browser"),
    (("src/engine/",), "Session Engine", "the background process that runs sessions"),
    (("src/web/",), "Web server", "the services behind the app"),
    (("src/launcher/", "vibenode.py", "session_manager.py", "reviver.py"), "Start and stop",
     "launching, starting at sign-in and recovery"),
    (("src/shared/",), "Shared code", "code the engine and the server both use"),
    (("src/features/workforce/",), "Agent library", "agents and playbooks"),
    (("src/features/pipeline/",), "Code Pipeline", "the build-and-verify workflow"),
    (("src/features/",), "Experiments", "comparisons and A/B tests"),
    (("requirements", "pyproject"), "Dependencies", "packages DevelopNode installs"),
    (("tests/",), "Tests", "checks that guard the app"),
    (("docs/", "README", "CONTRIBUTING"), "Docs", "documentation and screenshots"),
]
_OTHER = ("Other files", "files outside the main areas")
_LAST = {"Tests", "Docs", "Other files"}          # listed after the parts people use
_AUTO_TITLE = re.compile(r"^Update .*\(\d+ files?\)$|^Merge ")


def area_of(path: str) -> tuple:
    p = path.replace("\\", "/").lstrip("./")
    for prefixes, name, what in AREAS:
        if p.startswith(prefixes):
            return name, what
    return _OTHER


def group(paths) -> list:
    """[{name, what, files}] for these paths, biggest first, tests and docs last."""
    seen: dict = {}
    for p in paths:
        p = (p or "").strip()
        if not p:
            continue
        name, what = area_of(p)
        a = seen.setdefault(name, {"name": name, "what": what, "files": 0})
        a["files"] += 1
    return sorted(seen.values(), key=lambda a: (a["name"] in _LAST, -a["files"], a["name"]))


def _git(proj: Path, *args) -> list:
    try:
        r = subprocess.run(["git", "-C", str(proj), *args], capture_output=True, text=True,
                           timeout=10, creationflags=_NO_WINDOW)
    except Exception:
        return []
    return r.stdout.splitlines() if r.returncode == 0 else []


def _notes(lines) -> list:
    """Commit titles someone wrote, never the generated ones."""
    out = []
    for s in lines:
        s = s.strip()
        if s and not _AUTO_TITLE.search(s) and s not in out:
            out.append(s)
    return out[:8]


def changes(proj: Path) -> dict:
    """{incoming: {files, areas, notes}, outgoing: {files, areas, notes}}."""
    inc = _git(proj, "diff", "--name-only", "HEAD...@{upstream}")
    out = _git(proj, "diff", "--name-only", "@{upstream}...HEAD")
    for line in _git(proj, "status", "--porcelain", "--untracked-files=all"):
        path = line[3:].split(" -> ")[-1].strip().strip('"')
        if path and path not in out:
            out.append(path)
    return {
        "incoming": {"files": len(inc), "areas": group(inc),
                     "notes": _notes(_git(proj, "log", "--format=%s", "HEAD..@{upstream}"))},
        "outgoing": {"files": len(out), "areas": group(out),
                     "notes": _notes(_git(proj, "log", "--format=%s", "@{upstream}..HEAD"))},
    }

"""A clean security check the server may rely on instead of repeating it.

A publish used to check every file for keys and personal details three times:
the browser's check (/api/git-scan-stream) right before the sync, the server's
own check before staging, and a last one after staging.  The middle one read
the same files the browser's check had just passed.

Here a clean browser check is remembered with a fingerprint of the working
copy: the path and content hash of every file the check reads.  The server's
pre-staging check is skipped only when ALL of these hold:

- the check passed with nothing found;
- the files did not change while it ran (fingerprint taken before and after);
- the working copy's fingerprint now is identical;
- the check finished less than ``MAX_AGE_S`` ago (rules the scanner reads
  from outside the working copy, such as remembered names, can change).

The check after staging always runs: it is the last gate before anything is
committed.  Anything that cannot be fingerprinted means "check again".
"""

from __future__ import annotations

import hashlib
import threading
import time
from pathlib import Path

MAX_AGE_S = 600

_lock = threading.Lock()
_last: dict | None = None    # {"repo", "fp", "files", "at"}


def fingerprint(repo: Path) -> str | None:
    """Path + content hash of every tracked and every untracked, not-ignored
    file: the set the security check reads.  None when it cannot be taken."""
    try:
        from .gate_reuse import listed_files, _file_hash
        h = hashlib.sha256()
        files = listed_files(repo)
        for rel in files:
            h.update(rel.encode("utf-8", "surrogateescape"))
            h.update(b"\0")
            h.update(_file_hash(repo / rel).encode())
            h.update(b"\n")
        return h.hexdigest() + ":" + str(len(files))
    except Exception:
        return None


def record_clean(repo: Path, before: str | None, after: str | None, files: int) -> bool:
    """Remember a clean check whose files did not change while it ran."""
    global _last
    with _lock:
        if not before or before != after:
            _last = None
            return False
        _last = {"repo": str(Path(repo).resolve()), "fp": before, "files": files, "at": time.time()}
        return True


def forget() -> None:
    global _last
    with _lock:
        _last = None


def clean_now(repo: Path, now: float | None = None) -> dict | None:
    """The remembered clean check, if it still covers the working copy exactly."""
    with _lock:
        last = dict(_last) if _last else None
    if not last or last["repo"] != str(Path(repo).resolve()):
        return None
    if (now if now is not None else time.time()) - last["at"] > MAX_AGE_S:
        return None
    if fingerprint(repo) != last["fp"]:
        return None
    return last

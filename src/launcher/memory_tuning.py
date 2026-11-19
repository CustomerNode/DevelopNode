"""
Keep VibeNode's long-lived Python processes from hoarding freed memory (Linux).

WHY THIS EXISTS
---------------
On a busy Linux host the web server was seen at 10.7 GB RSS after a day and
starved the whole machine (browser pages "unresponsive", remote desktop
dropping, swap full).  It was not a Python leak: Python's own object arenas
held about 0.01 GB.  7.4 GB sat in 123 of glibc's per-thread malloc arenas
(~64 MB each) and 2.6 GB more in their sub-heaps.

Every request/socket thread that reads a big transcript (they reach 200+ MB
once the CLI writes ``api-request`` records with full request bodies)
allocates the raw lines through malloc in *its own* arena.  When the thread is
done, Python frees the strings, but glibc keeps the pages in that arena and
never gives them back.  With up to 8 x cores arenas (128 on a 16-core box) the
high-water mark of every thread stays resident forever, so RSS only ratchets
up.  A memory sample of the process was full of stale ``{"type":"api-request"``
lines and tool output, and a walk of glibc's own chunk headers in the live
process found 0.05 GB of chunks in use against 4.3 GB free but resident.

THE FIX (both halves are standard for threaded Python servers on glibc)
  1. Cap the number of malloc arenas (``M_ARENA_MAX``) so freed memory is
     shared instead of stranded per thread.  glibc fixes the limit the first
     time a thread needs an arena, so ``cap_arenas()`` must run at the very
     top of an entry point, before any import that starts a thread.
     Also exported as ``MALLOC_ARENA_MAX`` so children (test runs, CLIs)
     inherit it at their own start.
  2. A daemon thread calls ``malloc_trim(0)`` every minute, which hands free
     pages in every arena back to the OS.

Everything is best-effort and never raises: on Windows/macOS/musl it is a
no-op.  Stdlib-only, so both entry points (run.py, daemon_server.py) can import
it at boot.  Regression tests: tests/test_memory_tuning.py.
"""

import os
import sys
import threading

M_ARENA_MAX = -8          # glibc mallopt() parameter number
ARENA_MAX = 2             # the usual recommendation for threaded servers
TRIM_INTERVAL_S = 60.0
TRIMMER_THREAD_NAME = "vibenode-malloc-trim"

_trimmer = None
_lock = threading.Lock()


def _libc():
    """glibc handle, or None when this isn't Linux + glibc."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes
        import ctypes.util

        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        # Both symbols are glibc-only; musl lacks malloc_trim.
        libc.mallopt
        libc.malloc_trim
        return libc
    except Exception:
        return None


def is_supported() -> bool:
    return _libc() is not None


def cap_arenas(n: int = ARENA_MAX) -> bool:
    """Limit glibc malloc arenas for this process (affects arenas created from
    now on, so call before starting worker threads).  Also exports
    MALLOC_ARENA_MAX for child processes.  Returns True if applied."""
    libc = _libc()
    if libc is None:
        return False
    try:
        os.environ.setdefault("MALLOC_ARENA_MAX", str(n))
        return bool(libc.mallopt(M_ARENA_MAX, int(n)))
    except Exception:
        return False


def trim_now() -> bool:
    """Return free pages from every malloc arena to the OS.  True if supported."""
    libc = _libc()
    if libc is None:
        return False
    try:
        libc.malloc_trim(0)
        return True
    except Exception:
        return False


def rss_mb() -> int:
    """Resident memory of this process in MB (Linux), or -1."""
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return -1


LOG_MIN_FREED_MB = 64


def _log_trim(log_path, before: int, after: int) -> None:
    """Append one line when a trim gave back a meaningful amount, so the effect
    is visible in production.  Kept under ~1 MB."""
    if not log_path or before < 0 or after < 0 or before - after < LOG_MIN_FREED_MB:
        return
    try:
        import time
        if os.path.exists(log_path) and os.path.getsize(log_path) > 1 << 20:
            os.replace(log_path, str(log_path) + ".1")
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  malloc_trim: "
                     f"RSS {before} MB -> {after} MB (freed {before - after} MB)\n")
    except Exception:
        pass


def start_trimmer(interval: float = TRIM_INTERVAL_S, log_path=None):
    """Start (once) a daemon thread that trims every ``interval`` seconds.
    Returns the thread, or None where unsupported."""
    global _trimmer
    if _libc() is None:
        return None
    with _lock:
        if _trimmer is not None and _trimmer.is_alive():
            return _trimmer

        stop = threading.Event()

        def _loop():
            while not stop.wait(interval):
                before = rss_mb()
                trim_now()
                _log_trim(log_path, before, rss_mb())

        t = threading.Thread(target=_loop, name=TRIMMER_THREAD_NAME, daemon=True)
        t.stop_event = stop
        t.start()
        _trimmer = t
        return t


def stop_trimmer() -> None:
    """Stop the trimmer thread (tests; the server never needs this)."""
    global _trimmer
    with _lock:
        if _trimmer is not None:
            _trimmer.stop_event.set()
            _trimmer.join(timeout=5)
            _trimmer = None


def apply(log_path=None) -> bool:
    """Boot hook: cap arenas and start the trimmer.  Never raises."""
    try:
        capped = cap_arenas()
        start_trimmer(log_path=log_path)
        return capped
    except Exception:
        return False

"""Regression tests for launcher/memory_tuning.py.

The bug: on Linux the web server's RSS only ever went up (10.7 GB in a day).
Walking glibc's chunk headers in the live process showed ~0.05 GB in use and
4.3 GB free but still resident in per-thread malloc arenas: the server freed
its memory but glibc never handed it back.  These tests pin the fix:

  * both long-lived entry points call memory_tuning.apply() at boot, the web
    server before it starts any threads,
  * apply() never raises and is a no-op off glibc,
  * on glibc: the arena cap is applied and exported to children, the trimmer
    thread starts exactly once and really calls malloc_trim on schedule, and a
    trim that frees a lot is logged.
"""

import os
import re
import time
from pathlib import Path

import pytest

from launcher import memory_tuning as mt

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

glibc_only = pytest.mark.skipif(not mt.is_supported(), reason="needs Linux + glibc")


@pytest.mark.parametrize("rel", ["launcher/run.py", "engine/daemon_server.py"])
def test_entry_points_apply_memory_tuning_at_boot(rel):
    text = (SRC / rel).read_text(encoding="utf-8")
    assert re.search(r"from launcher import memory_tuning\s+memory_tuning\.apply\(", text), (
        f"{rel} must call memory_tuning.apply() at boot, or its RSS ratchets up on Linux")


@pytest.mark.parametrize("rel", ["launcher/run.py", "engine/daemon_server.py"])
def test_arena_cap_runs_before_any_thread_can_start(rel):
    """glibc fixes the arena limit the first time a thread needs an arena, so a
    cap applied after any thread exists does nothing.  It did exactly that once:
    applied in run.py's __main__ while a boot-watchdog thread started at import,
    and the restarted server still had 21 arenas."""
    text = (SRC / rel).read_text(encoding="utf-8")
    cap = text.find("cap_arenas()")
    assert cap != -1, f"{rel} must cap malloc arenas at the top of the file"
    for later in ("from launcher import _early_boot", "threading.Thread(", "threading.Timer("):
        pos = text.find(later)
        if pos != -1:
            assert cap < pos, f"{rel}: cap_arenas() must come before {later!r}"


def test_apply_never_raises_and_is_noop_off_glibc(monkeypatch):
    monkeypatch.setattr(mt, "_libc", lambda: None)
    assert mt.apply() is False
    assert mt.trim_now() is False
    assert mt.start_trimmer() is None


def test_big_trim_is_logged_small_one_is_not(tmp_path):
    log = tmp_path / "memory_trim.log"
    mt._log_trim(str(log), 900, 880)          # 20 MB: noise, not logged
    assert not log.exists()
    mt._log_trim(str(log), 9000, 1200)        # the real bug's scale
    assert "RSS 9000 MB -> 1200 MB (freed 7800 MB)" in log.read_text()


@glibc_only
def test_cap_arenas_applies_and_exports_env(monkeypatch):
    monkeypatch.delenv("MALLOC_ARENA_MAX", raising=False)
    assert mt.cap_arenas() is True
    assert os.environ["MALLOC_ARENA_MAX"] == str(mt.ARENA_MAX)


@glibc_only
def test_trimmer_runs_malloc_trim_on_schedule_and_starts_once(monkeypatch):
    calls = []
    monkeypatch.setattr(mt, "trim_now", lambda: calls.append(1) or True)
    mt.stop_trimmer()
    try:
        a = mt.start_trimmer(interval=0.05)
        b = mt.start_trimmer(interval=0.05)
        assert a is b and a.is_alive() and a.daemon and a.name == mt.TRIMMER_THREAD_NAME
        deadline = time.time() + 5
        while len(calls) < 3 and time.time() < deadline:
            time.sleep(0.05)
        assert len(calls) >= 3, "trimmer thread is not calling malloc_trim"
    finally:
        mt.stop_trimmer()
        assert not a.is_alive()


_ARENA_PROBE = r"""
import sys, struct, threading
sys.path.insert(0, sys.argv[1])
from launcher import memory_tuning as mt
def burst():
    # 16 threads alive at once, like a server's request threads (a thread that
    # exits first just hands its arena to the next one).
    gate = threading.Barrier(16)
    def work():
        held = [bytearray(4096) for _ in range(64)]
        gate.wait()
        del held
    ts = [threading.Thread(target=work) for _ in range(16)]
    for t in ts: t.start()
    for t in ts: t.join()
if sys.argv[2] == "thread-first":
    burst()                    # a thread allocates before the cap: limit frozen
mt.cap_arenas()
burst(); burst()
H = 64 << 20; arenas = set()
with open("/proc/self/mem", "rb", 0) as mem:
    for line in open("/proc/self/maps"):
        p = line.split(); a = int(p[0].split("-")[0], 16)
        if len(p) < 6 and a % H == 0 and "rw" in p[1]:
            mem.seek(a); arenas.add(struct.unpack("<Q", mem.read(8))[0])
print(len(arenas))
"""


@glibc_only
def test_cap_limits_arenas_when_applied_before_threads():
    import subprocess, sys
    def arenas(order):
        env = dict(os.environ); env.pop("MALLOC_ARENA_MAX", None)
        r = subprocess.run([sys.executable, "-c", _ARENA_PROBE, str(SRC), order],
                           capture_output=True, text=True, timeout=60, env=env)
        assert r.returncode == 0, r.stderr
        return int(r.stdout.strip())
    assert arenas("cap-first") <= mt.ARENA_MAX
    # Negative control: the probe really detects a cap that comes too late.
    assert arenas("thread-first") > mt.ARENA_MAX


@glibc_only
def test_trim_now_calls_glibc():
    assert mt.trim_now() is True
    assert mt.rss_mb() > 0

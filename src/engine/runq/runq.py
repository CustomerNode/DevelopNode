"""runq: one machine-wide queue for heavy dev jobs (test runs, type checks, builds).

Every pytest controller, vitest run, tsc check and vite build on this laptop
asks runq for admission before it starts.  runq:

  * admits a job only when its estimated memory fits in what is free right now
    (minus a reserve for the person at the keyboard), and caps how many heavy
    jobs run at once; the rest wait their turn, oldest first;
  * batches identical runs: a run with the same command on the same code (git
    HEAD + working-tree changes) as one already running waits for it and
    replays its output if it passed; one that passed in the last REUSE_S
    seconds is replayed at once, without running again.  A failed run is
    never replayed: the next one runs for real.

No daemon: state is a folder of small JSON files under %LOCALAPPDATA%\\runq,
guarded by a file lock.  A lease belongs to a live process; when the process
dies, the lease is dropped by the next caller.  Every failure inside runq
fails OPEN: the job runs as if runq were not there.

A machine HOLD (a release gate, a benchmark: work whose timing other jobs
would distort) makes new heavy jobs wait while its owner lives; light jobs
still start. A hold is a JSON file named after its owner's pid in the holds
folder: {"pid", "started" (field 22 of /proc/<pid>/stat on Linux), "label",
"t" (epoch seconds)}, so a shell script can take one without importing runq.
A hold whose owner died, or older than HOLD_MAX_S, is ignored, and a waiter
past MAX_WAIT_S starts anyway: a hold delays the queue, never stops it.

Two lanes, each oldest-first: LIGHT jobs (one process: a single test file
with no workers, a type check) and HEAVY ones (a parallel suite, a build).
A light job never waits behind a suite; a lane with nothing running always
starts its next job, so neither starves on a machine that is already full.

Knobs (environment):
  RUNQ_DISABLE=1          bypass entirely
  RUNQ_NO_REUSE=1         never replay; still queue
  RUNQ_KEY_ENV=A,B        extra env vars that make two runs different
  RUNQ_RESERVE_MB         memory left free beside heavy jobs (default 2500)
  RUNQ_MAX_JOBS           heavy jobs at once                 (default 4)
  RUNQ_LIGHT_MB           largest light job                  (default 2000)
  RUNQ_LIGHT_RESERVE_MB   memory left free beside light jobs (default 1000)
  RUNQ_LIGHT_JOBS         light jobs at once                 (default 6)

Budgets are learned: every running job reports its real memory every few
seconds, and the next run of the same tool in the same folder is budgeted
from what such runs really used (an estimate from its worker count until
then).  A running job only holds back the memory it has budgeted but not
used yet; what it uses is already gone from free memory.
  RUNQ_MAX_WAIT_S         after this long, the head of a lane starts even
                          without room, still one at a time  (default 2700)
  RUNQ_REUSE_S        how long a finished run is replayed (default 600)
  RUNQ_HOLD_MAX_S     a machine hold older than this is ignored (default 7200)
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

STATE = Path(os.environ.get("RUNQ_STATE_DIR")
             or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "runq")
LEASES = STATE / "leases"
WAITING = STATE / "waiting"
RESULTS = STATE / "results"
HOLDS = STATE / "holds"
LOCK = STATE / ".lock"
LOG = STATE / "runq.log"


def _env_int(name, default):
    try:
        v = int(os.environ.get(name, ""))
        return v if v >= 0 else default
    except ValueError:
        return default


RESERVE_MB = _env_int("RUNQ_RESERVE_MB", 2500)
# Free memory is the real limit; the counts only stop a burst of tiny jobs
# from all starting in the same second before any of them has grown.
MAX_JOBS = _env_int("RUNQ_MAX_JOBS", 4)
# The light lane: one-process jobs, a smaller reserve, their own count.
LIGHT_MB = _env_int("RUNQ_LIGHT_MB", 2000)
LIGHT_RESERVE_MB = _env_int("RUNQ_LIGHT_RESERVE_MB", 1000)
LIGHT_JOBS = _env_int("RUNQ_LIGHT_JOBS", 6)
PROFILES = STATE / "profiles.json"
LEARN_MARGIN = 1.15   # learned peak x this = the budget
MAX_WAIT_S = _env_int("RUNQ_MAX_WAIT_S", 2700)
REUSE_S = _env_int("RUNQ_REUSE_S", 600)
HOLD_MAX_S = _env_int("RUNQ_HOLD_MAX_S", 7200)
FRESH_S = 90          # a lease this young has not reached its full memory yet
POLL_S = 2.0

# Estimated peak memory per job kind, MB.
PYTEST_BASE_MB, PYTEST_WORKER_MB = 500, 900
VITEST_BASE_MB, VITEST_WORKER_MB = 600, 450
TSC_MB = 2000
VITE_BUILD_MB = 3000


# --- small helpers ------------------------------------------------------------

def log(msg):
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%m-%d %H:%M:%S')} [{os.getpid()}] {msg}\n")
    except OSError:
        pass


def say(msg):
    """One line to the job's stderr so the session sees why it waits."""
    try:
        sys.stderr.write(f"[runq] {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass


def available_mb():
    if os.name == "nt":
        import ctypes

        class MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = MS()
        m.dwLength = ctypes.sizeof(MS)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return int(m.ullAvailPhys // (1024 * 1024))
        return None
    try:
        with open("/proc/meminfo", encoding="ascii") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def process_started(pid):
    """Creation time of ``pid`` as a float, or None if it is not running.
    Comparing it guards against a recycled pid keeping a lease alive."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, int(pid))  # QUERY_LIMITED_INFORMATION
        if not h:
            return None
        try:
            code = wintypes.DWORD()
            if not k.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != 259:
                return None
            c, e, kt, ut = (wintypes.FILETIME() for _ in range(4))
            if not k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(ut)):
                return 0.0
            return float((c.dwHighDateTime << 32) | c.dwLowDateTime)
        finally:
            k.CloseHandle(h)
    try:
        os.kill(int(pid), 0)
    except OSError:
        return None
    try:
        # Fields after the command name, which may hold spaces: [0] is the
        # state, [19] the start time (field 22). An exited process its parent
        # has not reaped (state Z) still answers kill(0) but runs nothing.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else float(fields[19])
    except (OSError, IndexError, ValueError):
        return 0.0


def alive(rec):
    started = process_started(rec.get("pid", 0))
    return started is not None and (not rec.get("started") or started == rec["started"])


@contextlib.contextmanager
def state_lock():
    STATE.mkdir(parents=True, exist_ok=True)
    for d in (LEASES, WAITING, RESULTS, HOLDS):
        d.mkdir(exist_ok=True)
    fh = open(LOCK, "a+")
    try:
        if os.name == "nt":
            import msvcrt
            deadline = time.time() + 30
            while True:
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.time() > deadline:
                        raise TimeoutError("runq state lock")
                    time.sleep(0.05)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        fh.close()


def _read(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write(p, rec):
    tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(rec), encoding="utf-8")
    os.replace(tmp, p)


def _live(folder):
    """Records in ``folder`` whose process lives; dead ones are removed."""
    out = []
    for p in folder.glob("*.json"):
        rec = _read(p)
        if rec and alive(rec):
            rec["_path"] = str(p)
            out.append(rec)
        else:
            p.unlink(missing_ok=True)
    return out


def _holds():
    """Live machine holds younger than HOLD_MAX_S (call under the state lock)."""
    now = time.time()
    return [h for h in _live(HOLDS) if now - float(h.get("t") or 0) < HOLD_MAX_S]


def hold(label, pid=None):
    """Hold the machine for ``pid`` (default: this process) until release()
    or its exit: new heavy jobs wait meanwhile."""
    pid = int(pid or os.getpid())
    rec = {"pid": pid, "started": process_started(pid), "label": str(label), "t": time.time()}
    with state_lock():
        _write(HOLDS / f"{pid}.json", rec)
    log(f"hold by pid {pid}: {label}")
    return rec


def release(pid=None):
    with state_lock():
        (HOLDS / f"{int(pid or os.getpid())}.json").unlink(missing_ok=True)


# --- what a job is ------------------------------------------------------------

def code_state(cwd, timeout=15):
    """git HEAD + a digest of tracked changes and untracked files' names and
    mtimes, or None when not in a git tree (then nothing is replayed)."""
    try:
        def git(*a):
            return subprocess.run(["git", *a], cwd=cwd, capture_output=True,
                                  timeout=timeout, creationflags=_NO_WINDOW).stdout
        top = git("rev-parse", "--show-toplevel").decode().strip()
        head = git("rev-parse", "HEAD").decode().strip()
        if not top or not head:
            return None
        h = hashlib.sha256()
        h.update(top.encode() + b"\0" + head.encode() + b"\0")
        h.update(git("diff", "HEAD", "--binary"))
        for name in git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0"):
            # Files a run itself leaves behind are not code: without this the
            # first run's own __pycache__ made every second run look new.
            if name and not _GENERATED.search(name.decode(errors="replace")):
                try:
                    st = os.stat(os.path.join(top, name.decode(errors="replace")))
                    h.update(name + b"%d:%d" % (st.st_mtime_ns, st.st_size))
                except OSError:
                    h.update(name)
        return h.hexdigest()
    except Exception:
        return None


_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_GENERATED = re.compile(r"(^|/)(__pycache__|\.pytest_cache|\.cache|\.vite|\.run_logs|coverage|"
                        r"\.mypy_cache|\.ruff_cache|node_modules)(/|$)|\.py[co]$|\.tsbuildinfo$")


def job_key(kind, cwd, args, env_keys=("PYTEST_ADDOPTS", "CI", "NODE_ENV")):
    state = code_state(cwd)
    if state is None:
        return None
    h = hashlib.sha256()
    h.update(kind.encode() + b"\0" + str(Path(cwd).resolve()).lower().encode() + b"\0")
    h.update(json.dumps(list(args)).encode() + b"\0" + state.encode())
    extra = [k for k in os.environ.get("RUNQ_KEY_ENV", "").split(",") if k]
    for k in (*env_keys, *extra):
        h.update(f"{k}={os.environ.get(k, '')}".encode() + b"\0")
    return h.hexdigest()[:32]


# --- admission ----------------------------------------------------------------

def light(weight):
    """A one-process run (a single test file, a type check): it has its own
    lane, so it never waits behind a whole suite."""
    return weight <= LIGHT_MB


def _still_to_grow(r, now):
    """Memory a running job has budgeted but not used yet. Free memory already
    counts what it uses; only the rest is still coming."""
    if "cur" in r:
        return max(0, r.get("weight", 0) - r["cur"])
    return r.get("weight", 0) if now - r.get("t", now) < FRESH_S else 0


def _fits(weight, leases, avail):
    lane = [r for r in leases if light(r.get("weight", 0)) == light(weight)]
    if not lane:
        return True        # never starve: a lane with nothing running runs its next job
    cap = LIGHT_JOBS if light(weight) else MAX_JOBS
    if cap and len(lane) >= cap:
        return False
    if avail is None:
        return True
    now = time.time()
    pending = sum(_still_to_grow(r, now) for r in leases)
    reserve = LIGHT_RESERVE_MB if light(weight) else RESERVE_MB
    return avail - pending - weight >= reserve


# --- learning what jobs really use --------------------------------------------

def _profile_key(kind, cwd):
    return f"{kind}|{str(Path(cwd).resolve()).lower()}"


def learned_weight(kind, cwd, estimate):
    """The budget for a job: its estimate, scaled by how this tool's runs in
    this folder actually compared with their estimates. A project whose test
    workers are small stops being budgeted like one whose workers are large."""
    prof = (_read(PROFILES) or {}).get(_profile_key(kind, cwd))
    if not prof or not prof.get("ratio"):
        return estimate
    ratio = min(1.5, max(0.1, float(prof["ratio"])))
    return max(200, int(estimate * ratio * LEARN_MARGIN))


def _learn(rec):
    peak, est = rec.get("peak"), rec.get("est")
    if not peak or not est or rec.get("samples", 0) < 2:
        return
    profiles = _read(PROFILES) or {}
    k = _profile_key(rec["kind"], rec["cwd"])
    ratio = peak / est
    old = profiles.get(k)
    # The biggest recent run matters most: a new ratio above the old one is
    # taken at once, a lower one only eases in.
    if old and old.get("ratio"):
        ratio = ratio if ratio > old["ratio"] else 0.7 * old["ratio"] + 0.3 * ratio
    profiles[k] = {"ratio": round(ratio, 4), "n": (old or {}).get("n", 0) + 1, "t": time.time()}
    if len(profiles) > 400:
        for key in sorted(profiles, key=lambda x: profiles[x].get("t", 0))[:100]:
            profiles.pop(key, None)
    _write(PROFILES, profiles)


def tree_mb(pid):
    """Physical memory of ``pid`` and all its descendants, MB (None if unknown)."""
    try:
        if os.name == "nt":
            return _tree_mb_windows(int(pid))
        return _tree_mb_posix(int(pid))
    except Exception:
        return None


def _tree_mb_windows(root):
    import ctypes
    from ctypes import wintypes
    k = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi

    class PE(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_void_p),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]

    class PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

    k.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    k.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(PE)]
    k.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(PE)]
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    k.OpenProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(PMC), wintypes.DWORD]
    snap = k.CreateToolhelp32Snapshot(0x2, 0)
    children = {}
    try:
        e = PE()
        e.dwSize = ctypes.sizeof(PE)
        ok = k.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            children.setdefault(e.th32ParentProcessID, []).append(e.th32ProcessID)
            ok = k.Process32NextW(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    total, todo, seen = 0, [root], set()
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        seen.add(p)
        todo.extend(children.get(p, []))
        h = k.OpenProcess(0x1000, False, p)
        if not h:
            continue
        try:
            m = PMC()
            m.cb = ctypes.sizeof(PMC)
            if psapi.GetProcessMemoryInfo(h, ctypes.byref(m), m.cb):
                total += m.WorkingSetSize
        finally:
            k.CloseHandle(h)
    return int(total // (1024 * 1024))


def _tree_mb_posix(root):
    children = {}
    rss = {}
    page = os.sysconf("SC_PAGE_SIZE")
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            stat = Path(f"/proc/{d}/stat").read_text().rsplit(")", 1)[1].split()
            children.setdefault(int(stat[1]), []).append(int(d))
            rss[int(d)] = int(stat[21]) * page
        except (OSError, IndexError, ValueError):
            continue
    total, todo = 0, [root]
    while todo:
        p = todo.pop()
        total += rss.get(p, 0)
        todo.extend(children.get(p, []))
    return int(total // (1024 * 1024))


def sample(lease_id, pid):
    """Record what a running job uses now (called every few seconds by its owner)."""
    mb = tree_mb(pid)
    if mb is None:
        return
    try:
        with state_lock():
            p = LEASES / f"{lease_id}.json"
            rec = _read(p)
            if not rec:
                return
            rec["cur"] = mb
            rec["peak"] = max(mb, rec.get("peak", 0))
            rec["samples"] = rec.get("samples", 0) + 1
            _write(p, rec)
    except Exception:
        pass


def start_sampler(lease_id, pid, every=3.0):
    """A daemon thread in the job's own process that samples it until exit."""
    import threading

    def loop():
        while True:
            time.sleep(every)
            sample(lease_id, pid)
    threading.Thread(target=loop, name="runq-sampler", daemon=True).start()


#: Builds leave files behind (a bundle, a binary, an image): replaying their
#: printed output would skip the files, so they queue but are never replayed.
NO_REUSE_KINDS = {"vite-build", "webpack", "go-build", "cargo-build", "docker-build"}


def admit(kind, weight, cwd, args, pid=None, label=""):
    """Block until this job may run (or should replay an identical one).

    Returns ("run", lease_id, capture_path) or ("replay", output_path, code)
    or ("bypass", None, None) when runq is off or broken."""
    if os.environ.get("RUNQ_DISABLE") == "1" or os.environ.get("RUNQ_LEASE"):
        return ("bypass", None, None)
    pid = int(pid or os.getpid())
    try:
        return _admit(kind, weight, cwd, args, pid, label)
    except Exception as exc:          # fail open, always
        log(f"admit failed open: {exc!r}")
        return ("bypass", None, None)


def _admit(kind, weight, cwd, args, pid, label):
    started = process_started(pid)
    key = (None if os.environ.get("RUNQ_NO_REUSE") == "1" or kind in NO_REUSE_KINDS
           else job_key(kind, cwd, args))
    ticket = f"{time.time():.6f}-{pid}"
    estimate = weight
    weight = learned_weight(kind, cwd, estimate)
    me = {"pid": pid, "started": started, "kind": kind, "weight": weight, "est": estimate,
          "cwd": str(cwd), "label": label, "key": key, "t": time.time()}
    t0 = time.time()
    told = 0.0
    with state_lock():
        _write(WAITING / f"{ticket}.json", me)
    try:
        while True:
            with state_lock():
                # Batch: an identical run finished recently, or is running now.
                if key:
                    res = _read(RESULTS / f"{key}.json")
                    if res and time.time() - res.get("finished", 0) < REUSE_S \
                            and Path(res.get("output", "")).is_file():
                        log(f"replay {kind} {label} ({key})")
                        return ("replay", res["output"], int(res.get("code", 1)))
                leases = _live(LEASES)
                twin = next((r for r in leases if key and r.get("key") == key), None)
                waiting = sorted(_live(WAITING), key=lambda r: r["t"])
                avail = available_mb()
                if twin is None:
                    # Oldest first within each lane.
                    ahead = [w for w in waiting if w["t"] < me["t"]
                             and light(w.get("weight", 0)) == light(weight)]
                    # Past the longest wait, the head of the lane starts even
                    # without room, but still one at a time and holding a
                    # lease: a long queue drains in order, never all at once.
                    overdue = time.time() - t0 > MAX_WAIT_S
                    held = [] if light(weight) else _holds()
                    if not ahead and (overdue or (not held and _fits(weight, leases, avail))):
                        lease_id = ticket
                        cap = RESULTS / f"{ticket}.out"
                        rec = dict(me, t=time.time(), capture=str(cap))
                        _write(LEASES / f"{lease_id}.json", rec)
                        (WAITING / f"{ticket}.json").unlink(missing_ok=True)
                        waited = time.time() - t0
                        if waited > 3:
                            say(f"started after waiting {waited:.0f}s")
                        log(f"run {kind} w={weight} avail={avail} jobs={len(leases)+1} waited={waited:.0f}s {label}")
                        return ("run", lease_id, str(cap))
            if time.time() - told > 60:
                told = time.time()
                if twin:
                    say(f"an identical {kind} run is in progress; waiting to reuse its result")
                elif held:
                    say(f"queued: the machine is held by {held[0].get('label') or 'another job'}; "
                        f"starting when it ends")
                else:
                    say(f"queued: {len(leases)} heavy job(s) running, {avail} MB free; "
                        f"waiting for room ({weight} MB needed)")
            time.sleep(POLL_S)
    finally:
        with contextlib.suppress(Exception):
            (WAITING / f"{ticket}.json").unlink(missing_ok=True)


def finish(lease_id, code):
    """Drop the lease; keep the output for identical runs."""
    try:
        with state_lock():
            p = LEASES / f"{lease_id}.json"
            rec = _read(p)
            p.unlink(missing_ok=True)
            if rec:
                _learn(rec)
            # Only a PASSING run is replayed: a failure always runs again, so
            # re-running to check a flaky test still means something.
            if rec and rec.get("key") and code == 0:
                _write(RESULTS / f"{rec['key']}.json",
                       {"output": rec.get("capture"), "code": int(code), "finished": time.time()})
            _prune_results()
    except Exception as exc:
        log(f"finish failed: {exc!r}")


def _prune_results(keep_s=3 * 3600):
    now = time.time()
    for p in RESULTS.glob("*"):
        try:
            if now - p.stat().st_mtime > keep_s:
                p.unlink()
        except OSError:
            pass


def status():
    with state_lock():
        leases, waiting = _live(LEASES), sorted(_live(WAITING), key=lambda r: r["t"])
        holds = _holds()
    now = time.time()
    print(f"free memory: {available_mb()} MB  reserve: {RESERVE_MB} MB  max jobs: {MAX_JOBS}")
    for h in holds:
        print(f"held by pid {h['pid']} for {now - float(h.get('t') or now):.0f}s: {h.get('label', '')[:80]}")
    print(f"running ({len(leases)}):")
    for r in leases:
        used = f"{r['cur']:>6}" if "cur" in r else "     ?"
        print(f"  {r['kind']:<10} {r['weight']:>6} MB budget {used} MB used  {now - r['t']:>5.0f}s  "
              f"pid {r['pid']}  {r['label'][:80]}")
    print(f"waiting ({len(waiting)}):")
    for r in waiting:
        print(f"  {r['kind']:<10} {r['weight']:>6} MB  {now - r['t']:>5.0f}s  pid {r['pid']}  {r['label'][:90]}")


# --- CLI (used by the Node preload) ---------------------------------------------

def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "status"
    if cmd == "status":
        status()
        return 0
    if cmd == "admit":      # admit KIND WEIGHT PID CWD JSON_ARGS LABEL
        kind, weight, pid, cwd, args, label = argv[1], int(argv[2]), int(argv[3]), argv[4], json.loads(argv[5]), argv[6]
        print(json.dumps(admit(kind, weight, cwd, args, pid=pid, label=label)))
        return 0
    if cmd == "hold":       # hold LABEL [PID]
        hold(argv[1], int(argv[2]) if len(argv) > 2 else None)
        return 0
    if cmd == "release":    # release [PID]
        release(int(argv[1]) if len(argv) > 1 else None)
        return 0
    if cmd == "sample":     # sample LEASE PID
        sample(argv[1], int(argv[2]))
        return 0
    if cmd == "finish":     # finish LEASE CODE
        finish(argv[1], int(argv[2]))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())

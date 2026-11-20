"""Loaded at every Python start of a session (boot/sitecustomize.py, on the
session's PYTHONPATH); acts only for a pytest run.

A pytest controller asks runq for admission before pytest even imports:
it waits its turn when the machine is full, replays an identical run that
just passed, and otherwise runs with its output captured so identical runs
can reuse it.  Every other Python process returns from here at once.
"""
import os
import sys

EXIT = {"code": None}
_SKIP_FLAGS = {"--version", "-V", "-h", "--help", "--collect-only", "--co",
               "--fixtures", "--markers", "--setup-plan"}


def _pytest_args():
    argv = list(getattr(sys, "orig_argv", None) or [])
    if not argv:
        return None
    rest = argv[1:]
    # python -m pytest ...  |  pytest.exe ...
    for i, a in enumerate(rest):
        if a == "-m" and i + 1 < len(rest) and rest[i + 1] in ("pytest", "py.test"):
            return rest[i + 2:]
        if a == "-c" or (a == "-m"):
            return None
        if not a.startswith("-"):
            break
    base = os.path.basename(argv[0]).lower()
    if base in ("pytest", "pytest.exe", "py.test", "py.test.exe"):
        return rest
    return None


def _workers(args, cwd):
    """Workers the run will start, for its memory estimate."""
    for i, a in enumerate(args):
        val = None
        if a in ("-n", "--numprocesses") and i + 1 < len(args):
            val = args[i + 1]
        elif a.startswith("--numprocesses="):
            val = a.split("=", 1)[1]
        elif a.startswith("-n") and len(a) > 2 and a[2:].isdigit():
            val = a[2:]
        if val is not None:
            return int(val) if val.isdigit() else _auto()
        if a == "no:xdist" and i and args[i - 1] == "-p":
            return 0
    if any(a.startswith("addopts=") or a.startswith("--override-ini=addopts") for a in args):
        return 0           # the config's -n is overridden away
    for name in ("pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"):
        try:
            with open(os.path.join(cwd, name), encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        if '"-n"' in text or "-n auto" in text or "-n=auto" in text:
            return _auto()
    return 0


def _auto():
    """What ``-n auto`` will start.  xdist's own answer is a worker per core;
    unless something set it, it becomes half the cores, at most 6, so one run
    never takes the whole machine (a project's own pytest_xdist_auto_num_workers
    hook still decides first)."""
    if not os.environ.get("PYTEST_XDIST_AUTO_NUM_WORKERS"):
        cores = os.cpu_count() or 2
        os.environ["PYTEST_XDIST_AUTO_NUM_WORKERS"] = str(max(1, min(6, cores // 2)))
    try:
        return int(os.environ["PYTEST_XDIST_AUTO_NUM_WORKERS"])
    except ValueError:
        return 6


class _Tee:
    def __init__(self, stream, sink):
        self._s, self._k = stream, sink

    def write(self, data):
        try:
            self._k.write(data)
        except Exception:
            pass
        return self._s.write(data)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        try:
            self._k.flush()
        except Exception:
            pass
        return self._s.flush()

    def __getattr__(self, name):
        return getattr(self._s, name)


def _run():
    if os.environ.get("RUNQ_DISABLE") == "1" or os.environ.get("RUNQ_LEASE") \
            or os.environ.get("PYTEST_XDIST_WORKER"):
        return
    args = _pytest_args()
    if args is None or any(a in _SKIP_FLAGS for a in args):
        return
    import runq
    cwd = os.getcwd()
    workers = _workers(args, cwd)
    weight = runq.PYTEST_BASE_MB + max(workers, 1) * runq.PYTEST_WORKER_MB
    label = "pytest " + " ".join(args)[:200]
    action, a, b = runq.admit("pytest", weight, cwd, args, label=label)
    if action == "replay":
        sys.stderr.write("[runq] identical run on the same code just passed: replaying its result\n")
        with open(a, encoding="utf-8", errors="replace") as fh:
            sys.stdout.write(fh.read())
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(b)
    if action != "run":
        return
    lease, capture = a, b
    os.environ["RUNQ_LEASE"] = lease          # nested runs never queue behind us
    sink = open(capture, "w", encoding="utf-8", errors="replace")
    sys.stdout = _Tee(sys.stdout, sink)
    sys.stderr = _Tee(sys.stderr, sink)
    plugins = os.environ.get("PYTEST_PLUGINS", "")
    os.environ["PYTEST_PLUGINS"] = (plugins + "," if plugins else "") + "runq_pytest"

    import atexit

    def _done():
        try:
            sink.flush()
            sink.close()
        except Exception:
            pass
        runq.finish(lease, EXIT["code"])
    atexit.register(_done)


try:
    _run()
except SystemExit:
    raise
except Exception as _exc:   # never break Python start-up
    try:
        import runq as _r
        _r.log(f"boot failed open: {_exc!r}")
    except Exception:
        pass

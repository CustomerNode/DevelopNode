"""Stand-in for go, cargo and docker (the shims folder is first on a session's
PATH).  A heavy subcommand (go test/build, cargo test/build/check/clippy/bench,
docker build) asks runq for admission, then runs the real tool with its
output captured; anything else runs the real tool straight away.  Any
failure here runs the real tool as if runq were not there.

    python -E -s runq_shim.py TOOL [args...]
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SHIMS = os.path.join(HERE, "shims")

# tool -> {subcommand: (kind, weight MB)}
HEAVY = {
    "go": {"test": ("go-test", 2500), "build": ("go-build", 1500), "vet": ("go-test", 1500)},
    "cargo": {"test": ("cargo-test", 3000), "build": ("cargo-build", 3000),
              "check": ("cargo-build", 2500), "clippy": ("cargo-build", 2500),
              "bench": ("cargo-test", 3000), "nextest": ("cargo-test", 3000)},
    "docker": {"build": ("docker-build", 3000)},
}


def real_tool(tool, path=None):
    """The real ``tool`` on PATH, skipping the shims folder."""
    exts = [""]
    if os.name == "nt":
        exts = [e.lower() for e in os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";") if e]
    # realpath: the shims folder may be reached through a link under another name.
    shims = os.path.normcase(os.path.realpath(SHIMS))
    for entry in (path if path is not None else os.environ.get("PATH", "")).split(os.pathsep):
        if not entry or os.path.normcase(os.path.realpath(entry)) == shims:
            continue
        for ext in exts:
            cand = os.path.join(entry, tool + ext)
            if os.path.isfile(cand) and (os.name == "nt" or os.access(cand, os.X_OK)):
                return cand
    return None


def heavy(tool, args):
    """(kind, weight) when ``args`` is a heavy subcommand of ``tool``, else None."""
    words = [a for a in args if not a.startswith("-")]
    if not words:
        return None
    table = HEAVY.get(tool, {})
    if tool == "docker" and words[0] in ("buildx", "image", "compose") and len(words) > 1:
        return table.get("build") if words[1] == "build" else None
    if tool == "cargo" and words[0].startswith("+") and len(words) > 1:   # cargo +nightly test
        words = words[1:]
    return table.get(words[0])


def _pump(src, dst, sink):
    for chunk in iter(lambda: src.read1(65536) if hasattr(src, "read1") else src.read(65536), b""):
        try:
            dst.write(chunk)
            dst.flush()
        except Exception:
            pass
        try:
            sink.write(chunk)
        except Exception:
            pass


def run_captured(cmd, capture, env, on_start=None):
    with open(capture, "wb") as sink:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        if on_start:
            on_start(p.pid)
        t1 = threading.Thread(target=_pump, args=(p.stdout, sys.stdout.buffer, sink), daemon=True)
        t2 = threading.Thread(target=_pump, args=(p.stderr, sys.stderr.buffer, sink), daemon=True)
        t1.start(); t2.start()
        code = p.wait()
        t1.join(); t2.join()
    return code


def main(argv):
    if not argv:
        sys.stderr.write("runq_shim: no tool given\n")
        return 2
    tool, args = argv[0], argv[1:]
    real = real_tool(tool)
    if real is None:
        sys.stderr.write(f"{tool}: command not found\n")
        return 127
    cmd = [real, *args]
    job = None if os.environ.get("RUNQ_LEASE") else heavy(tool, args)
    if job is None:
        return subprocess.call(cmd)
    try:
        sys.path.insert(0, HERE)
        import runq
        kind, weight = job
        action, a, b = runq.admit(kind, weight, os.getcwd(), [tool, *args],
                                  label=f"{tool} " + " ".join(args)[:200])
    except Exception:
        return subprocess.call(cmd)
    if action == "replay":
        sys.stderr.write("[runq] identical run on the same code just passed: replaying its result\n")
        with open(a, "rb") as fh:
            sys.stdout.buffer.write(fh.read())
        sys.stdout.flush()
        return int(b)
    if action != "run":
        return subprocess.call(cmd)
    env = dict(os.environ, RUNQ_LEASE=a)
    code = None
    try:
        code = run_captured(cmd, b, env, on_start=lambda pid: runq.start_sampler(a, pid))
        return code
    finally:
        runq.finish(a, code)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

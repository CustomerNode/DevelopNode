"""Resource queue for heavy jobs that sessions start (test runs, type checks,
builds).

Agents do not know how many other sessions share the machine, so each one
starts its test suite with a worker per core and the machine runs out of
memory and stalls. Every session VibeNode launches gets this queue in its
environment: pytest (any project, any virtualenv) and Node's vitest, tsc and
vite build ask for admission first, wait while the machine is full, and an
identical run on unchanged code that just passed is replayed instead of run
again. See runq.py for the rules and knobs; VIBENODE_RUNQ=0 turns it off.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BOOT_DIR = HERE / "boot"
NODE_PRELOAD = HERE / "runq_node.cjs"


def console_python() -> str:
    """A python that has a console stream (the engine may run as pythonw)."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe":
        twin = exe.with_name("python.exe")
        if twin.is_file():
            return str(twin)
    return str(exe)


def enabled(env) -> bool:
    return str(env.get("VIBENODE_RUNQ", "1")).strip().lower() not in ("0", "off", "false", "no")


def session_env(env: dict) -> dict:
    """``env`` with the queue wired in, for a session's CLI process."""
    if not enabled(env):
        return env
    out = dict(env)
    boot = str(BOOT_DIR)
    parts = [p for p in out.get("PYTHONPATH", "").split(os.pathsep) if p]
    if boot not in parts:
        out["PYTHONPATH"] = os.pathsep.join([boot, *parts])
    preload = f'--require "{NODE_PRELOAD.as_posix()}"'
    node = out.get("NODE_OPTIONS", "")
    if NODE_PRELOAD.as_posix() not in node:
        out["NODE_OPTIONS"] = (node + " " + preload).strip()
    out.setdefault("RUNQ_PYTHON", console_python())
    return out

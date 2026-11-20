"""Sessions run below the person's own apps: the CLI (and so everything it
runs) starts at below-normal priority unless VIBENODE_SESSION_PRIORITY=normal."""

import asyncio
import os
import sys

import pytest

from engine import session_host as sh


def test_background_is_the_default_and_normal_opts_out():
    assert sh.session_runs_in_background({}) is True
    assert sh.session_runs_in_background({"VIBENODE_SESSION_PRIORITY": "normal"}) is False
    assert sh.session_runs_in_background({"VIBENODE_SESSION_PRIORITY": " OFF "}) is False


def _priority_of_started_cli(tmp_path, monkeypatch, setting):
    if setting is None:
        monkeypatch.delenv("VIBENODE_SESSION_PRIORITY", raising=False)
    else:
        monkeypatch.setenv("VIBENODE_SESSION_PRIORITY", setting)
    # A stand-in CLI that reports its own priority, then its child's: the
    # child proves the setting is inherited by whatever the session runs.
    probe = (
        "import os, subprocess, sys\n"
        "def prio():\n"
        "    if os.name == 'nt':\n"
        "        import ctypes\n"
        "        k = ctypes.windll.kernel32\n"
        "        k.GetCurrentProcess.restype = ctypes.c_void_p\n"
        "        k.GetPriorityClass.argtypes = [ctypes.c_void_p]\n"
        "        return k.GetPriorityClass(k.GetCurrentProcess())\n"
        "    return os.getpriority(os.PRIO_PROCESS, 0)\n"
        "if len(sys.argv) > 1:\n"
        "    print(prio(), flush=True); sys.exit(0)\n"
        "child = subprocess.run([sys.executable, __file__, 'child'], capture_output=True, text=True)\n"
        "print(prio(), child.stdout.strip(), flush=True)\n"
    )
    script = tmp_path / "probe.py"
    script.write_text(probe)

    async def run():
        cli = sh.CLIProcess({"argv": [sys.executable, str(script)], "sid": "prio", "test_cli": True}, folder=tmp_path)
        await cli.start()
        out = await asyncio.wait_for(cli.proc.stdout.readline(), 60)
        await cli.proc.wait()
        return out.decode().split()

    return asyncio.run(run())


def test_the_cli_and_its_children_start_below_normal(tmp_path, monkeypatch):
    own, child = _priority_of_started_cli(tmp_path, monkeypatch, None)
    if os.name == "nt":
        assert int(own) == sh.BELOW_NORMAL_PRIORITY
        assert int(child) == sh.BELOW_NORMAL_PRIORITY
    else:
        assert int(own) >= sh.POSIX_BACKGROUND_NICE


@pytest.mark.skipif(os.name != "nt", reason="priority class is Windows-only")
def test_normal_setting_keeps_normal_priority(tmp_path, monkeypatch):
    own, child = _priority_of_started_cli(tmp_path, monkeypatch, "normal")
    NORMAL = 0x20
    # This test process itself may already run below normal (it is session
    # work); "normal" means: not lowered further than the parent.
    import ctypes
    k = ctypes.windll.kernel32
    k.GetCurrentProcess.restype = ctypes.c_void_p
    k.GetPriorityClass.argtypes = [ctypes.c_void_p]
    parent = k.GetPriorityClass(k.GetCurrentProcess())
    assert int(own) in (NORMAL, parent)

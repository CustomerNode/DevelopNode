"""A Linux run re-starts itself in a sandbox and must still record its pass.

tests/conftest.py sets VIBENODE_TEST_REUSE=0 for its own process (the suite's
tests must never reuse a real record), then on Linux re-executes the same
command inside a PID namespace.  The re-executed run read that "0" as the
caller's wish, so no passing whole-suite run was ever recorded on Linux and
the Publish gate never reused one (src/web/gate_reuse.py).
"""

import sys
from types import SimpleNamespace

import pytest


def _conftest():
    for mod in list(sys.modules.values()):
        if getattr(mod, "_SANDBOX_CMD", None) and hasattr(mod, "_CALLER_REUSE"):
            return mod
    pytest.skip("the suite's conftest is not loaded")


class _Execd(Exception):
    pass


def _env_handed_to_sandbox(monkeypatch, tmp_path, caller_value):
    c = _conftest()
    seen = {}

    def fake_exec(cmd, args, env):
        seen["env"] = env
        raise _Execd()

    monkeypatch.setattr(c, "_CALLER_REUSE", caller_value)
    monkeypatch.setattr(c, "_sandbox_available", lambda: True)
    monkeypatch.setattr(c.sys, "platform", "linux")
    monkeypatch.setattr(c.os, "execvpe", fake_exec)
    monkeypatch.setattr(c.os, "chdir", lambda p: None)
    monkeypatch.delenv(c._SANDBOX_ENV, raising=False)
    monkeypatch.delenv("VIBENODE_TEST_NO_SANDBOX", raising=False)
    monkeypatch.setenv("VIBENODE_TEST_REUSE", "0")      # what the suite set for itself
    config = SimpleNamespace(invocation_params=SimpleNamespace(args=("tests/",), dir=tmp_path))
    with pytest.raises(_Execd):
        c.pytest_configure(config)
    return seen["env"]


def test_a_caller_who_set_nothing_gets_a_run_that_records(monkeypatch, tmp_path):
    env = _env_handed_to_sandbox(monkeypatch, tmp_path, None)
    assert "VIBENODE_TEST_REUSE" not in env


def test_a_caller_who_turned_reuse_off_keeps_it_off(monkeypatch, tmp_path):
    env = _env_handed_to_sandbox(monkeypatch, tmp_path, "0")
    assert env["VIBENODE_TEST_REUSE"] == "0"

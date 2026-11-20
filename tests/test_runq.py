"""Resource queue: admission waits for room, identical passing runs are
replayed, failures run again, and a session's environment routes real pytest
and Node jobs through it."""
import importlib
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from engine import runq as package

RUNQ_DIR = Path(package.__file__).resolve().parent
PY = package.console_python()


@pytest.fixture
def rq(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNQ_STATE_DIR", str(tmp_path / "state"))
    for k in ("RUNQ_LEASE", "RUNQ_DISABLE", "RUNQ_NO_REUSE"):
        monkeypatch.delenv(k, raising=False)
    from engine.runq import runq as core
    core = importlib.reload(core)
    core.POLL_S = 0.05
    return core


def _git_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    (path / "a.txt").write_text("1")
    _commit(path)
    return path


def _commit(path):
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(["git", "-c", "user.email=dev@example.com", "-c", "user.name=Dev",
                    "commit", "-qm", "x"], cwd=path, check=True)


def test_an_empty_machine_runs_anything(rq, tmp_path):
    action, lease, _ = rq.admit("pytest", 10**9, tmp_path, ["x"])
    assert action == "run"
    rq.finish(lease, 1)


def test_a_full_machine_queues_until_a_job_ends(rq, tmp_path):
    rq.MAX_JOBS = 1
    first = rq.admit("pytest", 5000, tmp_path, ["one"])
    assert first[0] == "run"
    got = {}

    def second():
        got["r"] = rq.admit("pytest", 5000, tmp_path, ["two"])
        got["t"] = time.time()

    th = threading.Thread(target=second)
    th.start()
    time.sleep(0.5)
    assert "r" not in got, "admitted while the machine was full"
    ended = time.time()
    rq.finish(first[1], 1)
    th.join(10)
    assert got["r"][0] == "run" and got["t"] >= ended
    rq.finish(got["r"][1], 1)


def test_a_single_file_run_never_waits_behind_a_suite(rq, tmp_path):
    """A full machine with a suite running and another queued: a one-process
    run still starts (its own lane), while a second suite waits."""
    rq.MAX_JOBS = 1
    suite = rq.admit("pytest", 6000, tmp_path, ["suite"])
    assert suite[0] == "run"
    got = {}
    th = threading.Thread(target=lambda: got.setdefault("suite2", rq.admit("pytest", 6000, tmp_path, ["suite2"])))
    th.start()
    time.sleep(0.3)
    small = rq.admit("pytest", 1400, tmp_path, ["one_file"])
    assert small[0] == "run" and "suite2" not in got
    rq.finish(small[1], 1)
    rq.finish(suite[1], 1)
    th.join(10)
    assert got["suite2"][0] == "run"
    rq.finish(got["suite2"][1], 1)


def test_memory_reserve_is_kept(rq):
    rq.RESERVE_MB = 3000
    settled = [{"weight": 5000, "t": time.time() - 1000}]
    assert rq._fits(3000, settled, avail=7000)
    assert not rq._fits(5000, settled, avail=7000)
    just_started = [{"weight": 5000, "t": time.time()}]   # not at full size yet: counted
    assert not rq._fits(3000, just_started, avail=7000)


def test_a_passing_run_is_replayed_and_a_failing_one_is_not(rq, tmp_path):
    repo = _git_repo(tmp_path / "repo")
    a = rq.admit("pytest", 100, repo, ["t"])
    Path(a[2]).write_text("5 passed\n")
    rq.finish(a[1], 0)
    assert rq.admit("pytest", 100, repo, ["t"]) == ("replay", a[2], 0)

    (repo / "a.txt").write_text("changed")              # different code: runs
    changed = rq.admit("pytest", 100, repo, ["t"])
    assert changed[0] == "run"
    rq.finish(changed[1], 1)                              # failed: never replayed
    assert rq.admit("pytest", 100, repo, ["t"])[0] == "run"


def test_files_a_run_leaves_behind_do_not_count_as_new_code(rq, tmp_path):
    repo = _git_repo(tmp_path / "repo")
    before = rq.code_state(repo)
    (repo / "__pycache__").mkdir()
    (repo / "__pycache__" / "a.cpython-312.pyc").write_bytes(b"x")
    assert rq.code_state(repo) == before


def test_nested_runs_bypass_the_queue(rq, tmp_path, monkeypatch):
    monkeypatch.setenv("RUNQ_LEASE", "parent")
    assert rq.admit("pytest", 100, tmp_path, ["x"])[0] == "bypass"


def test_a_dead_lease_frees_its_room(rq, tmp_path):
    rq.MAX_JOBS = 1
    with rq.state_lock():
        rq._write(rq.LEASES / "ghost.json", {"pid": 999999, "started": 1.0, "weight": 1, "t": time.time()})
    assert rq.admit("pytest", 100, tmp_path, ["x"])[0] == "run"


def test_session_env_wires_python_and_node_once():
    env = package.session_env({"PYTHONPATH": "keep", "NODE_OPTIONS": "--max-old-space-size=4096"})
    assert env["PYTHONPATH"].split(os.pathsep) == [str(package.BOOT_DIR), "keep"]
    assert env["NODE_OPTIONS"].startswith("--max-old-space-size=4096 --require")
    assert package.session_env(env) == env                 # idempotent
    assert package.session_env({"VIBENODE_RUNQ": "0"}) == {"VIBENODE_RUNQ": "0"}


def _session_env(tmp_path):
    env = {k: v for k, v in os.environ.items()
           if k not in ("RUNQ_LEASE", "RUNQ_DISABLE", "PYTEST_PLUGINS", "PYTEST_ADDOPTS",
                        "PYTHONPATH", "NODE_OPTIONS")}
    env = package.session_env(env)
    env["RUNQ_STATE_DIR"] = str(tmp_path / "state")
    return env


def test_a_sessions_pytest_run_goes_through_the_queue(tmp_path):
    repo = _git_repo(tmp_path / "repo")
    (repo / "test_ok.py").write_text("def test_ok():\n    assert True\n")
    _commit(repo)
    cmd = [PY, "-m", "pytest", "-q", "-p", "no:cacheprovider", "test_ok.py"]
    env = _session_env(tmp_path)
    one = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    two = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    assert one.returncode == 0 and "1 passed" in one.stdout, one.stdout + one.stderr
    assert two.returncode == 0 and "1 passed" in two.stdout
    assert "replaying" in two.stderr, two.stderr


def test_a_projects_own_sitecustomize_still_runs(tmp_path):
    own = tmp_path / "own"
    own.mkdir()
    (own / "sitecustomize.py").write_text("import os\nos.environ['OWN_SITE'] = 'ran'\n")
    env = _session_env(tmp_path)
    env["PYTHONPATH"] += os.pathsep + str(own)
    out = subprocess.run([PY, "-c", "import os; print(os.environ.get('OWN_SITE'))"],
                         capture_output=True, text=True, env=env, timeout=60)
    assert out.stdout.strip() == "ran", out.stderr


def test_a_sessions_node_job_goes_through_the_queue(tmp_path):
    repo = _git_repo(tmp_path / "repo")
    fake = repo / "node_modules" / "typescript" / "bin"
    fake.mkdir(parents=True)
    (fake / "tsc").write_text("console.log('typecheck ok'); process.exitCode = 0;\n")
    env = _session_env(tmp_path)
    cmd = ["node", str(fake / "tsc"), "--noEmit"]
    one = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    two = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    assert one.returncode == 0 and "typecheck ok" in one.stdout, one.stderr
    assert "replaying" in two.stderr and "typecheck ok" in two.stdout, two.stderr

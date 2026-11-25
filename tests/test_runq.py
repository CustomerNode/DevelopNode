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


def test_tree_memory_counts_children(rq):
    import sys as _sys
    child = subprocess.Popen([_sys.executable, "-c", "x = bytearray(150 * 1024 * 1024); import time; time.sleep(30)"])
    try:
        # Wait for the child to have allocated, not for a fixed time.
        deadline = time.time() + 30
        own = None
        while time.time() < deadline:
            own = rq.tree_mb(child.pid)
            if own is not None and own >= 140:
                break
            time.sleep(0.1)
        assert own is not None and own >= 140, own
        assert rq.tree_mb(os.getpid()) >= own          # the child is in our tree
    finally:
        child.kill()


def test_a_running_job_only_holds_back_what_it_has_not_used_yet(rq):
    now = time.time()
    assert rq._still_to_grow({"weight": 5000, "cur": 4000, "t": now}, now) == 1000
    assert rq._still_to_grow({"weight": 5000, "cur": 6000, "t": now}, now) == 0
    assert rq._still_to_grow({"weight": 5000, "t": now}, now) == 5000          # not measured yet
    assert rq._still_to_grow({"weight": 5000, "t": now - 600}, now) == 0      # old, never measured


def test_budgets_are_learned_from_real_use(rq, tmp_path):
    """A suite estimated at 14.9 GB that really peaks at 3 GB is budgeted near
    3.5 GB next time; a bigger run raises the budget at once."""
    est = 14900
    assert rq.learned_weight("pytest", tmp_path, est) == est             # nothing learned yet
    with rq.state_lock():
        rq._learn({"kind": "pytest", "cwd": str(tmp_path), "est": est, "peak": 3000, "samples": 5})
    w = rq.learned_weight("pytest", tmp_path, est)
    assert 3000 < w < 4000, w
    with rq.state_lock():
        rq._learn({"kind": "pytest", "cwd": str(tmp_path), "est": est, "peak": 9000, "samples": 5})
    assert rq.learned_weight("pytest", tmp_path, est) > 9000
    other = tmp_path / "other"
    other.mkdir()
    assert rq.learned_weight("pytest", other, est) == est                 # per project


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
    # A session's CLI is never a pytest worker. When this suite runs in
    # parallel, its workers set PYTEST_XDIST_*; a child inheriting them looks
    # like a worker of an outer run, and runq rightly stands aside for those.
    env = {k: v for k, v in os.environ.items()
           if k not in ("PYTEST_PLUGINS", "PYTEST_ADDOPTS", "PYTHONPATH", "NODE_OPTIONS")
           and not k.startswith(("PYTEST_XDIST_", "RUNQ_"))}
    env = package.session_env(env)
    env["RUNQ_STATE_DIR"] = str(tmp_path / "state")
    return env


def test_a_sessions_pytest_run_goes_through_the_queue(tmp_path):
    repo = _git_repo(tmp_path / "repo")
    (repo / "test_ok.py").write_text("def test_ok():\n    assert True\n")
    _commit(repo)
    cmd = [PY, "-m", "pytest", "-p", "no:cacheprovider", "-q", "test_ok.py"]
    env = _session_env(tmp_path)
    one = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    two = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    assert one.returncode == 0 and "1 passed" in one.stdout, one.stdout + one.stderr
    assert two.returncode == 0 and "1 passed" in two.stdout
    assert "replaying" in two.stderr, two.stderr


def test_a_sessions_run_is_measured_and_its_budget_learned(tmp_path):
    repo = _git_repo(tmp_path / "repo")
    (repo / "test_slow.py").write_text(
        "import time\ndef test_slow():\n    x = bytearray(120 * 1024 * 1024)\n    time.sleep(8)\n")
    _commit(repo)
    env = _session_env(tmp_path)
    r = subprocess.run([PY, "-m", "pytest", "-p", "no:cacheprovider", "-q", "test_slow.py"],
                       cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    import json as _json
    profiles = _json.loads((tmp_path / "state" / "profiles.json").read_text())
    (key, prof), = [(k, v) for k, v in profiles.items() if k.startswith("pytest|")]
    # peak ~ 120 MB + interpreter, against an estimate of 1400 MB
    assert 0.05 < prof["ratio"] < 0.5, prof


def test_a_projects_own_sitecustomize_still_runs(tmp_path):
    own = tmp_path / "own"
    own.mkdir()
    (own / "sitecustomize.py").write_text("import os\nos.environ['OWN_SITE'] = 'ran'\n")
    env = _session_env(tmp_path)
    env["PYTHONPATH"] += os.pathsep + str(own)
    out = subprocess.run([PY, "-c", "import os; print(os.environ.get('OWN_SITE'))"],
                         capture_output=True, text=True, env=env, timeout=60)
    assert out.stdout.strip() == "ran", out.stderr


def test_session_env_puts_the_tool_stand_ins_first_on_path():
    env = package.session_env({"PATH": os.pathsep.join(["a", "b"])})
    assert env["PATH"].split(os.pathsep) == [str(package.SHIMS_DIR), "a", "b"]


def test_heavy_subcommands_of_go_cargo_and_docker():
    from engine.runq import runq_shim as shim
    assert shim.heavy("go", ["test", "./..."])[0] == "go-test"
    assert shim.heavy("go", ["version"]) is None
    assert shim.heavy("cargo", ["+nightly", "test"])[0] == "cargo-test"
    assert shim.heavy("cargo", ["fmt"]) is None
    assert shim.heavy("docker", ["build", "-t", "x", "."])[0] == "docker-build"
    assert shim.heavy("docker", ["buildx", "build", "."])[0] == "docker-build"
    assert shim.heavy("docker", ["compose", "build"])[0] == "docker-build"
    assert shim.heavy("docker", ["ps"]) is None


def test_the_real_tool_is_found_past_the_stand_ins(tmp_path):
    from engine.runq import runq_shim as shim
    real = tmp_path / ("go.cmd" if os.name == "nt" else "go")
    real.write_text("@echo real\n" if os.name == "nt" else "#!/bin/sh\necho real\n")
    real.chmod(0o755)
    path = os.pathsep.join([str(package.SHIMS_DIR), str(tmp_path)])
    assert Path(shim.real_tool("go", path)).resolve() == real.resolve()


def _fake_go(tmp_path):
    fake = tmp_path / "fakebin"
    fake.mkdir()
    if os.name == "nt":
        (fake / "go.cmd").write_text("@echo off\r\necho ok  example/pkg %*\r\nexit /b 0\r\n")
    else:
        g = fake / "go"
        g.write_text("#!/bin/sh\necho \"ok  example/pkg $*\"\n")
        g.chmod(0o755)
    return fake


@pytest.mark.parametrize("shell", ["native", "sh"])
def test_a_sessions_go_test_goes_through_the_queue(tmp_path, shell):
    if shell == "sh" and os.name == "nt" and not shutil_which("bash"):
        pytest.skip("no bash")
    repo = _git_repo(tmp_path / "repo")
    env = _session_env(tmp_path)
    env["PATH"] = os.pathsep.join([str(package.SHIMS_DIR), str(_fake_go(tmp_path)),
                                   os.environ.get("PATH", "")])
    if shell == "native":
        cmd = "go test ./..." if os.name == "nt" else ["go", "test", "./..."]
        run = lambda: subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env,
                                     timeout=120, shell=(os.name == "nt"))
    else:
        bash = shutil_which("bash") or "bash"
        run = lambda: subprocess.run([bash, "-c", "go test ./..."], cwd=repo,
                                     capture_output=True, text=True, env=env, timeout=120)
    one, two = run(), run()
    assert one.returncode == 0 and "ok  example/pkg test ./..." in one.stdout, one.stdout + one.stderr
    assert two.returncode == 0 and "ok  example/pkg" in two.stdout
    assert "replaying" in two.stderr, two.stderr
    plain = (subprocess.run("go version" if os.name == "nt" else ["go", "version"], cwd=repo,
                            capture_output=True, text=True, env=env, timeout=60, shell=(os.name == "nt")))
    assert "ok  example/pkg version" in plain.stdout and "runq" not in plain.stderr


def shutil_which(name):
    """A POSIX shell for the sh stand-ins. On Windows that is Git's bash,
    never System32's bash.exe, which runs WSL Linux instead."""
    import shutil
    if os.name != "nt":
        return shutil.which(name)
    git = shutil.which("git")
    if not git:
        return None
    for base in Path(git).resolve().parents[:3]:
        cand = base / "bin" / "bash.exe"
        if cand.is_file():
            return str(cand)
    return None


@pytest.mark.parametrize("pkg,script,args,cap", [
    ("jest/bin", "jest.js", ["--ci"], "--maxWorkers="),
    ("@playwright/test", "cli.js", ["test"], "--workers="),
])
def test_a_sessions_js_test_run_is_capped_queued_and_replayed(tmp_path, pkg, script, args, cap):
    repo = _git_repo(tmp_path / "repo")
    fake = repo / "node_modules" / pkg
    fake.mkdir(parents=True)
    (fake / script).write_text("console.log('tool args ' + process.argv.slice(2).join(' '));\n")
    env = _session_env(tmp_path)
    cmd = ["node", str(fake / script), *args]
    one = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    two = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    assert one.returncode == 0 and cap in one.stdout, one.stdout + one.stderr
    assert "replaying" in two.stderr and "tool args" in two.stdout, two.stderr


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


def _hold_me(rq, label="release gate"):
    """A machine hold owned by this (live) test process."""
    return rq.hold(label, os.getpid())


def test_a_machine_hold_makes_suites_wait_but_not_single_files(rq, tmp_path):
    """While a hold is live (a release gate running), a new suite waits; a
    one-process run still starts; the suite starts once the hold ends."""
    _hold_me(rq)
    got = {}
    th = threading.Thread(target=lambda: got.setdefault("suite", rq.admit("pytest", 6000, tmp_path, ["suite"])))
    th.start()
    time.sleep(0.5)
    assert "suite" not in got, "a suite started while the machine was held"
    small = rq.admit("pytest", 1400, tmp_path, ["one_file"])
    assert small[0] == "run", "a single-file run waited behind the hold"
    rq.finish(small[1], 1)
    released = time.time()
    rq.release(os.getpid())
    th.join(10)
    assert got["suite"][0] == "run" and got["suite"] is not None
    rq.finish(got["suite"][1], 1)
    assert released <= time.time()


def test_a_hold_whose_owner_died_is_ignored(rq, tmp_path):
    with rq.state_lock():
        rq._write(rq.HOLDS / "999999.json", {"pid": 999999, "started": 1.0, "label": "gone", "t": time.time()})
    assert rq.admit("pytest", 6000, tmp_path, ["suite"])[0] == "run"


def test_a_hold_older_than_its_limit_is_ignored(rq, tmp_path):
    """A hold left by a crash on a recycled pid must not block the machine forever."""
    rec = rq.hold("stuck", os.getpid())
    with rq.state_lock():
        rec["t"] = time.time() - rq.HOLD_MAX_S - 1
        rq._write(rq.HOLDS / f"{os.getpid()}.json", rec)
    assert rq.admit("pytest", 6000, tmp_path, ["suite"])[0] == "run"


def test_a_suite_held_back_past_the_longest_wait_still_starts(rq, tmp_path):
    rq.MAX_WAIT_S = 0
    _hold_me(rq)
    assert rq.admit("pytest", 6000, tmp_path, ["suite"])[0] == "run"


def test_a_hold_written_by_a_shell_script_is_honoured(rq, tmp_path):
    """The protocol a non-Python owner (a release script) follows: a JSON file
    named after its pid in the holds folder, with pid, label and its start time
    as field 22 of /proc/<pid>/stat."""
    if os.name == "nt":
        pytest.skip("the shell protocol reads /proc")
    script = ('d="$RUNQ_STATE_DIR/holds"; mkdir -p "$d"; '
              'printf \'{"pid": %s, "started": %s, "label": "gate", "t": %s}\' '
              '"$$" "$(awk \'{print $22}\' /proc/$$/stat)" "$(date +%s)" > "$d/$$.json"; sleep 30')
    sh = subprocess.Popen(["bash", "-c", script], env=dict(os.environ))
    try:
        deadline = time.time() + 10
        while not list(rq.HOLDS.glob("*.json")) and time.time() < deadline:
            time.sleep(0.05)
        got = {}
        th = threading.Thread(target=lambda: got.setdefault("suite", rq.admit("pytest", 6000, tmp_path, ["suite"])))
        th.start()
        time.sleep(0.5)
        assert "suite" not in got, "a shell-written hold did not hold the machine"
    finally:
        sh.kill()
        sh.wait()
    th.join(10)
    assert got["suite"][0] == "run", "the suite did not start after the hold's owner ended"
    rq.finish(got["suite"][1], 1)


def test_an_exited_owner_not_yet_reaped_counts_as_gone(rq, tmp_path):
    """A finished process its parent has not waited for (a zombie) still
    answers kill(0); it holds no machine and no memory, so it must not keep a
    hold or a lease alive."""
    if os.name == "nt":
        pytest.skip("zombies are a POSIX state")
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    try:
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                if Path(f"/proc/{child.pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
                    break
            except OSError:
                break
            time.sleep(0.02)
        assert rq.process_started(child.pid) is None, "an exited, unreaped process counted as running"
        rq.hold("gate", child.pid)
        assert rq.admit("pytest", 6000, tmp_path, ["suite"])[0] == "run"
    finally:
        child.wait()


def test_a_malformed_hold_is_ignored_and_the_queue_still_counts_memory(rq, tmp_path):
    """A hold whose time is not a number must neither raise (admission would
    then fail open and skip every memory check) nor hold the machine."""
    with rq.state_lock():
        rq._write(rq.HOLDS / f"{os.getpid()}.json", {"pid": os.getpid(), "label": "x", "t": "soon"})
    rq.MAX_JOBS = 1
    first = rq.admit("pytest", 5000, tmp_path, ["one"])
    assert first[0] == "run", "a malformed hold made the queue skip its checks or hold the machine"
    assert first[1] is not None, "admission failed open instead of granting a lease"
    rq.finish(first[1], 1)

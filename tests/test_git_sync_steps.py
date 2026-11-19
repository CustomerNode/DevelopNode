"""An Update / Publish reports each step as it starts, so the dialog fills its
ring step by step instead of spinning (src/web/git_ops.py ``sync_steps`` and
``progress``, src/web/routes/git_api.py /api/git-sync-stream)."""

import json
import subprocess

import pytest
from flask import Flask

from web import git_ops


def test_the_steps_follow_the_action():
    keys = lambda a: [k for k, _ in git_ops.sync_steps(a)]
    assert keys("pull") == ["pull", "restore", "finish"]
    assert keys("push") == ["scan", "save", "upload"]
    assert keys("both") == keys("pull") + keys("push")
    assert all(label for _, label in git_ops.sync_steps("both"))


def _fake_repo(tmp_path, monkeypatch):
    """A repo where every git call succeeds, recording nothing."""
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(git_ops, "_VIBENODE_DIR", tmp_path)
    monkeypatch.setattr(git_ops, "_current_branch", lambda *a: "main")
    monkeypatch.setattr(git_ops, "_default_branch", lambda *a: "main")
    monkeypatch.setattr(git_ops, "_unmerged_paths", lambda *a: [])
    monkeypatch.setattr(git_ops, "_remote_history_is_unrelated", lambda *a: False)
    monkeypatch.setattr(git_ops, "_requirements_blob", lambda *a: "same")
    monkeypatch.setattr(git_ops, "_run_post_update", lambda *a: True)
    from web import git_scanner
    monkeypatch.setattr(git_scanner, "scan_staged_files", lambda *a, **k: {"ok": True, "summary": ""})
    monkeypatch.setattr(git_scanner, "scan_outgoing_commits", lambda *a, **k: [])

    def run(cmd, *a, **k):
        out = "Already up to date." if "pull" in cmd else ""
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")
    monkeypatch.setattr(git_ops.subprocess, "run", run)


def _no_live_git(monkeypatch):
    monkeypatch.setattr(git_ops, "_git_live", lambda cmd, timeout, on=None: subprocess.CompletedProcess(
        cmd, 0, stdout="Already up to date." if "pull" in cmd else "", stderr=""))


def test_a_sync_reports_every_step_in_order_and_what_it_does_inside(tmp_path, monkeypatch):
    _fake_repo(tmp_path, monkeypatch)
    _no_live_git(monkeypatch)
    steps, details = [], []

    def progress(key, text=None, pct=None):
        if text is None:
            steps.append(key)
        else:
            details.append(key)
    r = git_ops.do_git_sync("both", progress=progress)
    assert r["ok"], r
    assert steps == ["pull", "restore", "finish", "scan", "save", "upload"]
    # Every step says what it is doing, under its own name.
    assert set(details) == set(steps)


def test_git_progress_lines_in_plain_words():
    p = git_ops.parse_git_progress
    assert p("Writing objects:  45% (9/20), 1.20 MiB | 300.00 KiB/s") == ("Uploading 9 of 20 · 1.20 MiB · 300.00 KiB/s", 45)
    assert p("Counting objects: 100% (12/12), done.") == ("Counting changes 12 of 12", 100)
    assert p("remote: Resolving deltas: 50% (2/4)") == ("Unpacking 2 of 4", 50)
    assert p("Receiving objects:  10% (1/10)") == ("Downloading 1 of 10", 10)
    assert p("To example.invalid:x/y.git") is None


def test_each_git_phase_has_its_own_slice_so_the_ring_only_moves_forward():
    share = git_ops.step_share
    assert share("Counting changes 12 of 12", 100) == 10
    assert share("Packing changes 1 of 20", 0) == 10
    assert share("Uploading 9 of 20", 50) == 60
    assert share("Uploading 20 of 20", 100) == 95
    assert share("Unpacking 1 of 1", 100) == 100
    assert share("Checked 3 of 9 files", 33) == 33
    assert share("Connecting to the server", None) is None


def _git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_a_real_push_reports_gits_own_upload_counts(tmp_path):
    """Against a real repository and remote: git's progress lines come through
    as they happen, and the push still succeeds with its usual output."""
    remote = tmp_path / "remote.git"
    work = tmp_path / "work"
    _git("init", "--bare", "-q", str(remote), cwd=tmp_path)
    _git("init", "-q", "-b", "main", str(work), cwd=tmp_path)
    _git("config", "user.email", "test@example.invalid", cwd=work)
    _git("config", "user.name", "Test Person", cwd=work)
    for i in range(30):
        (work / ("f%02d.txt" % i)).write_text(("line %d\n" % i) * 50)
    _git("add", "-A", cwd=work)
    _git("commit", "-q", "-m", "first", cwd=work)
    _git("remote", "add", "origin", str(remote), cwd=work)
    seen = []
    r = git_ops._git_live(["git", "-C", str(work), "push", "-u", "origin", "main"], 30,
                          lambda text, pct: seen.append((text, pct)))
    assert r.returncode == 0, r.stderr
    assert any(t.startswith("Uploading ") for t, _ in seen), seen
    assert any(p == 100 for _, p in seen)   # git's own count per phase; the sync maps it to a rising share
    assert all(0 <= p <= 100 for _, p in seen)
    assert "\r" not in r.stderr   # progress lines are not left in the output
    assert subprocess.run(["git", "-C", str(remote), "rev-parse", "main"], capture_output=True).returncode == 0


def test_a_broken_progress_reader_never_stops_the_sync(tmp_path, monkeypatch):
    _fake_repo(tmp_path, monkeypatch)

    _no_live_git(monkeypatch)

    def boom(key, text=None, pct=None):
        raise RuntimeError("reader went away")
    assert git_ops.do_git_sync("pull", progress=boom)["ok"]


def test_the_stream_names_the_steps_then_reports_them_then_the_result():
    from web.routes import git_api
    app = Flask(__name__)
    app.register_blueprint(git_api.bp)
    seen = {}

    def fake_sync(action, confirm_branch=False, summary="", gate=None, progress=None):
        seen.update(action=action, summary=summary, gate=gate)
        for key in ("pull", "restore", "finish"):
            progress(key)
            progress(key, "doing " + key, 50)
        return {"ok": True, "messages": ["Pulled."]}
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(git_api, "do_git_sync", fake_sync)
        mp.setattr(git_api, "get_git_cache", lambda: {"ahead": 0, "behind": 0})
        r = app.test_client().post("/api/git-sync-stream", json={"action": "pull", "summary": "x"})
        lines = [json.loads(l) for l in r.get_data(as_text=True).splitlines() if l.strip()]
    assert r.status_code == 200 and "ndjson" in r.headers["Content-Type"]
    assert lines[0] == {"type": "steps", "steps": [{"key": k, "label": l} for k, l in git_ops.sync_steps("pull")],
                        "job": lines[0]["job"]}
    # The same run, kept for a page that reloads mid-run: every event and the result.
    job = app.test_client().get("/api/git-sync-job").get_json()
    assert job["job"] == lines[0]["job"] and job["action"] == "pull" and job["done"] is True
    assert job["events"] == lines[1:] and job["count"] == len(lines) - 1
    assert job["result"] == lines[-1]["result"]
    later = app.test_client().get("/api/git-sync-job?since=4").get_json()
    assert later["events"] == lines[5:]
    assert [(e["type"], e["key"]) for e in lines[1:-1]] == [
        ("step", "pull"), ("detail", "pull"), ("step", "restore"), ("detail", "restore"),
        ("step", "finish"), ("detail", "finish")]
    assert lines[2] == {"type": "detail", "key": "pull", "text": "doing pull", "pct": 50}
    assert lines[-1] == {"type": "done", "result": {"ok": True, "messages": ["Pulled."],
                                                    "git_status": {"ahead": 0, "behind": 0}}}
    assert seen == {"action": "pull", "summary": "x", "gate": None}


def test_a_crash_in_the_sync_still_ends_the_stream_with_an_answer():
    from web.routes import git_api
    app = Flask(__name__)
    app.register_blueprint(git_api.bp)

    def fake_sync(*a, **k):
        raise RuntimeError("disk gone")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(git_api, "do_git_sync", fake_sync)
        mp.setattr(git_api, "get_git_cache", lambda: {})
        r = app.test_client().post("/api/git-sync-stream", json={"action": "both"})
        last = json.loads(r.get_data(as_text=True).strip().splitlines()[-1])
    assert last["type"] == "done" and last["result"]["ok"] is False
    assert "disk gone" in last["result"]["messages"][0]

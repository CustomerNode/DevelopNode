"""A publish relies on the browser's clean security check instead of reading
every file again, only when the working copy is exactly what was checked
(src/web/scan_pass.py).  The check after staging always runs."""

import subprocess
import time
from pathlib import Path

import pytest

from web import git_ops, git_scanner, scan_pass


def _git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    remote, work = tmp_path / "remote.git", tmp_path / "work"
    _git("init", "--bare", "-q", "-b", "main", str(remote), cwd=tmp_path)
    _git("init", "-q", "-b", "main", str(work), cwd=tmp_path)
    _git("config", "user.email", "test@example.invalid", cwd=work)
    _git("config", "user.name", "Test Person", cwd=work)
    (work / "app.py").write_text("print('hello')\n")
    _git("add", "-A", cwd=work)
    _git("commit", "-q", "-m", "start", cwd=work)
    _git("remote", "add", "origin", str(remote), cwd=work)
    _git("push", "-q", "-u", "origin", "main", cwd=work)
    monkeypatch.setattr(git_ops, "_VIBENODE_DIR", work)
    scan_pass.forget()
    yield work
    scan_pass.forget()


@pytest.fixture
def scans(monkeypatch):
    """Count the server's full security checks."""
    calls = []
    real = git_scanner.scan_staged_files

    def counted(proj=None, on_file=None):
        calls.append(proj)
        return real(proj, on_file=on_file)
    monkeypatch.setattr(git_scanner, "scan_staged_files", counted)
    return calls


def _browser_check_passed(repo):
    fp = scan_pass.fingerprint(repo)
    assert scan_pass.record_clean(repo, fp, scan_pass.fingerprint(repo), 1)


def test_a_clean_browser_check_spares_the_first_server_check_but_never_the_last(repo, scans):
    (repo / "app.py").write_text("print('changed')\n")
    _browser_check_passed(repo)
    details = []
    r = git_ops.do_git_sync("push", confirm_branch=True,
                            progress=lambda k, t=None, p=None: t and details.append((k, t)))
    assert r["ok"], r
    assert len(scans) == 1, "only the check after staging ran"
    assert any(k == "scan" and t.startswith("Already checked") for k, t in details), details


def test_any_change_after_the_browser_check_means_checking_again(repo, scans):
    _browser_check_passed(repo)
    (repo / "app.py").write_text("print('edited after the check')\n")
    assert git_ops.do_git_sync("push", confirm_branch=True)["ok"]
    assert len(scans) == 2


def test_a_new_file_after_the_browser_check_means_checking_again(repo, scans):
    (repo / "app.py").write_text("print('changed')\n")
    _browser_check_passed(repo)
    (repo / "extra.py").write_text("x = 1\n")
    assert git_ops.do_git_sync("push", confirm_branch=True)["ok"]
    assert len(scans) == 2


def test_files_that_changed_during_the_check_are_never_trusted(repo):
    before = scan_pass.fingerprint(repo)
    (repo / "app.py").write_text("print('mid-check')\n")
    assert not scan_pass.record_clean(repo, before, scan_pass.fingerprint(repo), 1)
    assert scan_pass.clean_now(repo) is None


def test_an_old_check_is_not_trusted(repo):
    _browser_check_passed(repo)
    assert scan_pass.clean_now(repo) is not None
    assert scan_pass.clean_now(repo, now=time.time() + scan_pass.MAX_AGE_S + 1) is None


def test_a_check_for_another_folder_is_not_trusted(repo, tmp_path):
    _browser_check_passed(repo)
    other = tmp_path / "other"
    other.mkdir()
    assert scan_pass.clean_now(other) is None


def test_a_finding_is_never_skipped(repo, scans):
    """A key added after a clean check is caught: the tree changed, so the
    server checks again and stops the publish."""
    (repo / "app.py").write_text("print('changed')\n")
    _browser_check_passed(repo)
    (repo / "app.py").write_text('KEY = "sk-ant-api03-' + "A" * 90 + '"\n')
    r = git_ops.do_git_sync("push", confirm_branch=True)
    assert not r["ok"] and r.get("scan")
    assert subprocess.run(["git", "-C", str(repo), "log", "--oneline"], capture_output=True,
                          text=True).stdout.count("\n") == 1, "nothing was committed"


def test_the_browser_check_route_records_only_a_clean_result(repo, monkeypatch):
    from flask import Flask
    from web.routes import git_api
    import web.config as cfg
    monkeypatch.setattr(cfg, "_VIBENODE_DIR", repo)
    app = Flask(__name__)
    app.register_blueprint(git_api.bp)
    monkeypatch.setattr(git_scanner, "scan_staged_files_stream",
                        lambda: iter(['{"type": "progress", "current": 1, "total": 1, "file": "app.py"}',
                                      '{"type": "done", "ok": true, "files_scanned": 1}']))
    app.test_client().get("/api/git-scan-stream").get_data()
    assert scan_pass.clean_now(repo) is not None
    monkeypatch.setattr(git_scanner, "scan_staged_files_stream",
                        lambda: iter(['{"type": "done", "ok": false, "files_scanned": 1}']))
    app.test_client().get("/api/git-scan-stream").get_data()
    assert scan_pass.clean_now(repo) is None

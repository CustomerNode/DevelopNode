"""What an Update brings in and a Publish sends out, by area (src/web/change_areas.py)."""

import subprocess

from web.change_areas import area_of, changes, group


def test_each_file_belongs_to_the_first_area_that_names_it():
    assert area_of("src/web/static/js/last-card.js")[0] == "Summary cards"
    assert area_of("src/web/static/js/git-sync.js")[0] == "Update and publish"
    assert area_of("src/web/static/js/folders.js")[0] == "Web app"
    assert area_of("src/engine/session_manager.py")[0] == "Session Engine"
    assert area_of("tests/test_x.py")[0] == "Tests"
    assert area_of("somewhere/else.txt")[0] == "Other files"


def test_areas_are_biggest_first_with_tests_and_docs_last():
    names = [a["name"] for a in group(["tests/a.py", "tests/b.py", "tests/c.py", "src/engine/a.py",
                                       "src/web/static/js/x.js", "src/web/static/js/y.js", "docs/api/z.md"])]
    assert names == ["Web app", "Session Engine", "Tests", "Docs"]


def _git(cwd, *a):
    subprocess.run(["git", "-C", str(cwd), *a], check=True, capture_output=True)


def test_changes_lists_incoming_and_outgoing_files_and_written_titles(tmp_path):
    origin, mine, other = tmp_path / "origin.git", tmp_path / "mine", tmp_path / "other"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True)
    for repo in (mine, other):
        subprocess.run(["git", "clone", "-q", str(origin), str(repo)], check=True, capture_output=True)
        _git(repo, "config", "user.email", "dev@example.com")
        _git(repo, "config", "user.name", "Dev")
    (mine / "README.md").write_text("x")
    _git(mine, "add", "."); _git(mine, "commit", "-qm", "Start"); _git(mine, "push", "-q", "origin", "HEAD")
    _git(other, "pull", "-q", "origin", "HEAD")
    (other / "src" / "engine").mkdir(parents=True)
    (other / "src" / "engine" / "a.py").write_text("x")
    _git(other, "add", "."); _git(other, "commit", "-qm", "Update engine (1 file)"); _git(other, "push", "-q", "origin", "HEAD")
    (mine / "tests").mkdir()
    (mine / "tests" / "t.py").write_text("x")
    _git(mine, "add", "."); _git(mine, "commit", "-qm", "Make the Sleep button stick")
    (mine / "notes.txt").write_text("y")            # not committed yet: still goes out
    _git(mine, "fetch", "-q")
    _git(mine, "branch", "-q", "--set-upstream-to", "origin/" + subprocess.run(
        ["git", "-C", str(mine), "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip())
    c = changes(mine)
    assert c["incoming"]["files"] == 1
    assert [a["name"] for a in c["incoming"]["areas"]] == ["Session Engine"]
    assert c["incoming"]["notes"] == []                       # a generated title is not a note
    assert c["outgoing"]["files"] == 2
    assert {a["name"] for a in c["outgoing"]["areas"]} == {"Tests", "Other files"}
    assert c["outgoing"]["notes"] == ["Make the Sleep button stick"]

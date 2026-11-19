"""The Home screen (a project chooser) answers "what needs me".

Against the real page (``tests/_fake_app.py``: the real ``index.html``, every
real script and the real CSS in headless Chromium; only the network is faked):

  * the open project's preview lists "Needs you" (sessions waiting on a question or
    permission first, then finished sessions with unread output) and
    "Running" (working sessions), each from SessionStore and the live state
    maps, and re-renders on the same state pushes as the counts;
  * with nothing waiting or running it says "Nothing needs you. N sleeping.";
  * a row opens its session;
  * the usage meters are drawn once a reading exists;
  * the strip under the project name shows Durable Jobs needing a person, an
    older-code Session Engine, and "Name N untitled sessions" at >= 10.
"""

from __future__ import annotations

import time

import pytest

from tests._browser import shared_browser_scope
from tests._fake_app import CWD, PROJECT, FakeApp, fake_sessions, init_script

XDIST_SPLITTABLE = True

HOME_READY = "document.querySelector('#homepage-container .homepage') !== null"


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _home(browser, sessions, *, extra="", routes=None):
    return FakeApp(browser, sessions, init=init_script(view_mode="homepage", extra=extra),
                   wait_for=HOME_READY, extra_routes=routes or {}, clock=True)


def _titles(app, list_id):
    return app.eval("(id) => Array.from(document.querySelectorAll('#' + id + ' .hpn-row .t')).map(e => e.textContent)",
                    list_id)


def _sessions(n=12, live=()):
    """Sleeping sessions the person already marked Done (a 'done' hold): Done
    is the person's verdict, not sleep, so a sleeping session with
    no verdict would sit in Needs you.  Rows at the indexes in *live* get no
    hold: the test drives them with state pushes."""
    rows = fake_sessions(n, base_ts=int(time.time()))
    for i, r in enumerate(rows):
        if i not in live:
            r["hold"] = "done"
    return rows


@pytest.mark.slow
def test_needs_you_and_running_lists(browser):
    rows = _sessions(live=(0, 1, 2, 3, 5))
    # Session 0003 has unread output from an earlier turn.
    extra = "localStorage.setItem('vn_unread_sessions', JSON.stringify(['%s']));" % rows[3]["id"]
    app = _home(browser, rows, extra=extra)
    try:
        app.push_many("session_state", [
            {"session_id": rows[0]["id"], "state": "working", "cwd": CWD},
            {"session_id": rows[1]["id"], "state": "waiting", "cwd": CWD},
            {"session_id": rows[2]["id"], "state": "working", "cwd": CWD},
            {"session_id": rows[3]["id"], "state": "idle", "cwd": CWD},
            {"session_id": rows[5]["id"], "state": "waiting", "cwd": CWD},
        ])
        app.page.wait_for_function("document.getElementById('hp-running-list') !== null", timeout=5000)
        needs = _titles(app, "hp-needs-list")
        running = _titles(app, "hp-running-list")
        # Questions first (newest first), then the unread finished one.
        assert needs == ["Session 0001", "Session 0005", "Session 0003"], needs
        assert sorted(running) == ["Session 0000", "Session 0002"], running
        assert app.eval("() => document.querySelector('#hp-needs-list .hpx-ico').classList.contains('question')")
        assert app.eval("() => !document.getElementById('hp-attention-empty')")
        # The lists follow state pushes, like the counts: a working session going idle leaves "Running".
        app.push("session_state", {"session_id": rows[2]["id"], "state": "idle", "cwd": CWD})
        app.page.wait_for_function(
            "Array.from(document.querySelectorAll('#hp-running-list .hpn-row .t')).map(e => e.textContent).join() === 'Session 0000'",
            timeout=5000)
        # The old five-item "Recent" list is gone.
        assert app.eval("() => !Array.from(document.querySelectorAll('.hpx-hd')).some(e => e.textContent === 'Recent')")
        assert not app.errors, app.errors
    finally:
        app.close()


@pytest.mark.slow
def test_lists_cap_at_five(browser):
    rows = _sessions(15)
    app = _home(browser, rows)
    try:
        app.push_many("session_state", [{"session_id": s["id"], "state": "working", "cwd": CWD} for s in rows[:8]]
                      + [{"session_id": s["id"], "state": "waiting", "cwd": CWD} for s in rows[8:15]])
        app.page.wait_for_function("document.getElementById('hp-running-list') !== null", timeout=5000)
        assert len(_titles(app, "hp-needs-list")) == 5
        assert len(_titles(app, "hp-running-list")) == 5
    finally:
        app.close()


@pytest.mark.slow
def test_empty_state_says_nothing_needs_you(browser):
    rows = _sessions(7)
    app = _home(browser, rows)
    try:
        app.page.wait_for_function("document.getElementById('hp-attention-empty') !== null", timeout=5000)
        assert app.eval("() => document.getElementById('hp-attention-empty').textContent") == \
            "Nothing needs you. 7 sleeping."
        # Open still leads to the project's sessions.
        assert app.eval("() => document.getElementById('hd-open').textContent.trim()") == "Open"
        assert app.eval("() => !document.getElementById('hp-needs-list') && !document.getElementById('hp-running-list')")
    finally:
        app.close()


@pytest.mark.slow
def test_clicking_a_row_opens_the_session(browser):
    rows = _sessions(6)
    app = _home(browser, rows)
    try:
        app.push("session_state", {"session_id": rows[4]["id"], "state": "waiting", "cwd": CWD})
        app.page.wait_for_function("document.querySelector('#hp-needs-list .hpn-row') !== null", timeout=5000)
        app.eval("() => document.querySelector('#hp-needs-list .hpn-row').click()")
        app.page.wait_for_function("(id) => window.viewMode === 'sessions' || viewMode === 'sessions'", arg=rows[4]["id"],
                                   timeout=5000)
        app.page.wait_for_function("(id) => typeof liveSessionId !== 'undefined' && liveSessionId === id",
                                   arg=rows[4]["id"], timeout=5000)
        assert not app.errors, app.errors
    finally:
        app.close()


@pytest.mark.slow
def test_strip_jobs_engine_and_naming(browser):
    rows = _sessions(4)
    jobs = {"ok": True, "jobs": [
        {"id": "j1", "state": "needs_person", "name": "transcribe"},
        {"id": "j2", "state": "failed", "name": "encode"},
        {"id": "j3", "state": "running", "name": "fine"},
    ]}
    engine = {"ok": True, "running": True, "stale": True, "outdated": ["src/engine/a.py", "src/engine/b.py", "src/engine/c.py"],
              "started_at": 1, "restart_armed": False}
    routes = {
        "/api/sessions/untitled-count": lambda req: (200, {"project": PROJECT, "total": 40, "untitled": 37, "nameable": 35}),
        "/api/jobs": lambda req: (200, jobs),
        "/api/engine/status": lambda req: (200, engine),
    }
    app = _home(browser, rows, routes=routes)
    try:
        app.page.wait_for_function("document.getElementById('hp-jobs-link') !== null", timeout=5000)
        assert app.eval("() => document.getElementById('hp-jobs-link').textContent") == "2 durable jobs need you"
        assert app.eval("() => document.getElementById('hp-name-untitled').textContent") == "Name 35 untitled sessions"
        # No "running older code" line: the engine restarts itself once idle
        # so there is nothing for the person to do about it.
        app.eval("() => EngineFreshness.check()")
        app.advance(800)
        assert app.eval("() => !document.getElementById('hp-engine-stale')")
        # The usage meters are absent until a reading exists, drawn when one
        # arrives, and not in the strip.
        assert app.eval("() => !document.getElementById('hs-usage')")
        app.eval("() => _ingestUsageLimits({windows: {five_hour: {percent: 42, resets_at: Date.now() / 1000 + 3600}}})")
        assert app.eval("() => document.getElementById('hs-usage').textContent") == "5-hour42%"
        assert app.eval("() => !document.querySelector('#hp-strip .hps-usage')")
        # The jobs link opens System -> Durable Jobs.
        app.eval("() => document.getElementById('hp-jobs-link').click()")
        app.page.wait_for_function("document.querySelector('#pm-overlay .pm-title') && "
                                   "document.querySelector('#pm-overlay .pm-title').textContent === 'Durable Jobs'",
                                   timeout=5000)
        assert not app.errors, app.errors
    finally:
        app.close()


@pytest.mark.slow
def test_strip_hides_naming_below_threshold(browser):
    rows = _sessions(4)
    routes = {"/api/sessions/untitled-count": lambda req: (200, {"project": PROJECT, "total": 9, "untitled": 9, "nameable": 9}),
              "/api/jobs": lambda req: (200, {"ok": True, "jobs": []})}
    app = _home(browser, rows, routes=routes)
    try:
        app.page.wait_for_function("() => !!window._untitledInfo", timeout=5000)   # the count has arrived
        app.advance(800)
        assert app.eval("() => !document.getElementById('hp-name-untitled')")
        assert app.eval("() => !document.getElementById('hp-jobs-link')")
        assert app.eval("() => !document.getElementById('hp-engine-stale')")
    finally:
        app.close()


@pytest.mark.slow
def test_workforce_counts_have_one_source(browser):
    """The Workforce view header reads workforceCounts() (folders.js), the one
    count of the installed department tree."""
    tree = {"version": 1, "rootChildren": ["eng", "ops"], "folders": {
        "eng": {"id": "eng", "name": "Engineering", "children": ["be"], "sessions": [],
                "skill": {"label": "Eng lead", "systemPrompt": "x"}},
        "be": {"id": "be", "name": "Backend", "children": [], "sessions": [],
               "skill": {"label": "Backend", "systemPrompt": "y"}},
        "ops": {"id": "ops", "name": "Ops", "children": [], "sessions": []},
    }}
    app = _home(browser, _sessions(3), routes={"/api/folder-tree": lambda req: (200, tree)})
    try:
        app.eval("() => setViewMode('workplace')")
        app.page.wait_for_function("!!document.querySelector('.wf-cc-subtitle')", timeout=5000)
        assert app.eval("() => JSON.stringify(workforceCounts())") == \
            '{"departments":2,"subDepartments":1,"agents":2}'
        sub = app.eval("() => document.querySelector('.wf-cc-subtitle').textContent")
        assert sub.startswith("2 departments · 1 sub-department"), sub
        assert app.eval("() => Array.from(document.querySelectorAll('.wf-mode-btn')).map(b => b.textContent)") == \
            ["Workspace", "Configure"]
        assert not app.errors, app.errors
    finally:
        app.close()



def _status(detail):
    return {"/api/project-status": lambda req: (200, detail)}


@pytest.mark.slow
def test_home_is_a_project_chooser(browser):
    """Every project is a card; choosing one previews it without leaving the
    open project; Open on another project switches to it."""
    other = "-home-test-other"
    projects = [{"encoded": PROJECT, "display": CWD, "custom_name": "", "session_count": 4, "active": True},
                {"encoded": other, "display": "/home/test/other", "custom_name": "Other", "session_count": 9, "active": False}]
    detail = {PROJECT: {"needs": 0, "standby": 0, "working": 0, "items": {"needs": [], "standby": [], "working": []},
                        "last_ts": 0, "daily": [0, 0, 0, 0, 0, 0, 4]},
              other: {"needs": 2, "standby": 1, "working": 1, "last_ts": time.time() - 7200, "daily": [1, 0, 2, 0, 0, 3, 1],
                      "items": {"needs": [{"id": "n1", "title": "Pick a pricing tier", "ts": time.time()},
                                          {"id": "n2", "title": "Approve the release", "ts": time.time() - 60}],
                                "standby": [], "working": [{"id": "w1", "title": "Write the docs", "ts": time.time()}]}}}
    routes = dict(_status(detail))
    routes["/api/projects"] = lambda req: (200, projects)
    app = _home(browser, _sessions(4), routes=routes)
    try:
        app.page.wait_for_function("document.querySelectorAll('#hd-side .hd-proj[data-enc]').length === 2", timeout=5000)
        # The open project is chosen first; the other shows how many need you.
        assert app.eval("() => document.querySelector('#hd-side .hd-proj.on').dataset.enc") == PROJECT
        app.page.wait_for_function("(e) => (document.querySelector('.hd-proj[data-enc=\"' + e + '\"] .ps-n.vs-needs') || {}).textContent === '2'",
                                   arg=other, timeout=5000)
        # The same three counts as the project picker: Needs you, Standby, Working.
        assert app.eval("(e) => Array.from(document.querySelectorAll('.hd-proj[data-enc=\"' + e + '\"] .ps-n')).map(n => n.textContent)", other) == ["2", "1", "1"]
        assert app.eval("() => document.querySelectorAll('.hd-ps-head > span').length") == 4
        app.eval("(e) => document.querySelector('.hd-proj[data-enc=\"' + e + '\"]').click()", other)
        assert app.eval("() => document.querySelector('.hd-name').textContent") == "Other"
        assert app.eval("() => Array.from(document.querySelectorAll('#hd-pane .hd-lists .hd-r .t')).map(e => e.textContent)") == \
            ["Pick a pricing tier", "Approve the release", "Write the docs"]
        assert app.eval("() => document.querySelector('.hd-stat.n b').textContent") == "2"
        assert app.eval("() => document.querySelector('.hd-stat:last-child b').textContent") == "7"
        # Choosing previews only: the open project has not changed.
        assert app.eval("() => localStorage.getItem('activeProject')") == PROJECT
        # A live update keeps the choice.
        app.eval("() => _updateHomepageStats()")
        assert app.eval("() => document.querySelector('.hd-name').textContent") == "Other"
        # Open switches to that project.
        app.eval("() => { window.__switched = null; window.selectProjectFromOverlay = (e) => { window.__switched = e; }; }")
        app.eval("() => document.getElementById('hd-open').click()")
        assert app.eval("() => window.__switched") == other
        assert not app.errors, app.errors
    finally:
        app.close()

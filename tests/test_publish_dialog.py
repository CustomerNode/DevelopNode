"""The Publish dialog records what changed and how the gate went
(src/web/static/js/git-sync.js), in a real browser.

Only the network and the test-run stream are faked; the dialog markup is the
one from index.html and the script is the real file.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from tests._browser import shared_browser_scope

XDIST_SPLITTABLE = True

ROOT = Path(__file__).resolve().parents[1]

MODES = {"fast": {"label": "Fast: unit + browser tests, 60s timeout"},
         "full": {"label": "Full: unit + browser tests, 120s timeout (Code Pipeline tests not included)"}}


def _page_html() -> str:
    src = (ROOT / "src" / "web" / "static" / "js" / "git-sync.js").read_text(encoding="utf-8")
    return f"""<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="btn-git-update"><span id="git-badge-pull"></span></button>
<button id="btn-git-publish"><span id="git-badge-push"></span></button>
<button id="btn-git-sync"><span id="git-badge-sync"></span></button>
<div class="overlay" id="git-sync-overlay">
  <div id="git-sync-title"></div>
  <button id="git-sync-minimize-btn"></button>
  <div id="git-sync-body"></div>
  <div class="modal-actions" id="git-sync-actions"></div>
</div>
<div id="git-sync-mini"><span id="git-sync-mini-label"></span><span id="git-sync-mini-spinner"></span>
  <button id="git-sync-mini-close"></button></div>
<script>
  window.__posts = [];
  window.__toasts = [];
  window.__syncResult = {{ok: true, messages: ['Pushed.'], git_status: {{ahead: 0, behind: 0, uncommitted: false}}}};
  window.__testDone = null;      // set by a test: the summary the fake run ends with
  function escHtml(s) {{ return String(s).replace(/[&<>"]/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}})[c]); }}
  function showToast(m) {{ window.__toasts.push(m); }}
  window.__stream = null;        // set by a test: a ReadableStream of step lines
  window.fetch = function (url, opts) {{
    var body = {{}};
    if (url === '/api/git-sync-stream' && window.__stream) {{
      window.__posts.push(JSON.parse(opts.body));
      return Promise.resolve(new Response(window.__stream, {{headers: {{'Content-Type': 'application/x-ndjson'}}}}));
    }}
    if (url === '/api/test-modes') body = {{modes: {json.dumps(MODES)}}};
    else if (url === '/api/git-sync') {{ window.__posts.push(JSON.parse(opts.body)); body = window.__syncResult; }}
    else if (url === '/api/git-status') body = {{ahead: 1, behind: 0, uncommitted: true, on_default: true}};
    return Promise.resolve({{ok: true, json: () => Promise.resolve(body)}});
  }};
  // The test run: ends at once with window.__testDone.
  function _streamTestRun(mode, h) {{ setTimeout(() => h.onDone(Object.assign({{mode: mode}}, window.__testDone), ['..F.']), 0); }}
</script>
<script>{src}</script>
<script>
  // Push path pieces that need a server: the streaming scan and the delays.
  _runStreamingScan = () => Promise.resolve({{ok: true, files_scanned: 3}});
  _applyGitStatus({{ahead: 1, behind: 0, uncommitted: true, on_default: true}});
</script>
</body></html>"""


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


@pytest.fixture
def page(browser):
    pg = browser.new_page(viewport={"width": 1100, "height": 700})
    pg.clock.install()   # the publish path's own pauses (300-400ms) run on _until
    pg.set_content(_page_html())
    yield pg
    pg.close()


def _until(page, expr, seconds=10):
    """Wait for ``expr``, firing the page's timers as they come due."""
    end = time.time() + seconds
    while not page.evaluate(expr):
        assert time.time() < end, f"never became true: {expr}"
        page.clock.run_for(100)


def _click(page, label):
    page.locator("#git-sync-actions button", has_text=label).first.click()


def _gate(page, mode):
    page.click(f"#gs-gate [data-gate={mode}]")


def test_the_dialog_has_the_summary_field_and_honest_mode_labels(page):
    """One Publish button; the test choice is Fast / Full / Skip, and the line
    under it states exactly what the picked mode runs."""
    page.evaluate("() => openGitPublish()")
    page.wait_for_selector("#git-publish-summary")
    assert "What changed?" in page.get_attribute("#git-publish-summary", "aria-label")
    hint = lambda: page.locator("#gs-gate-hint").text_content()
    assert hint() == MODES["fast"]["label"]
    _gate(page, "full")
    assert hint() == MODES["full"]["label"]
    _gate(page, "skip")
    assert hint() == "Skip: no tests run; the commit message says so."
    assert page.locator('#gs-gate [aria-checked="true"]').get_attribute("data-gate") == "skip"
    # The picked option is the grey raised segment, never the purple main button.
    assert page.locator("#gs-gate .pm-btn-primary").count() == 0
    assert page.locator("#gs-gate .on").get_attribute("data-gate") == "skip"
    assert [b.strip() for b in page.locator("#gs-gate button b").all_text_contents()] == ["Fast", "Full", "Skip"]
    # Each choice says what it runs, from the same honest label.
    assert page.locator("#gs-gate [data-gate=fast] small").text_content() == "unit + browser tests, 60s timeout"
    assert page.locator("#gs-gate [data-gate=full] small").text_content() == "unit + browser tests, 120s timeout"
    labels = [b.strip() for b in page.locator("#git-sync-actions button").all_text_contents()]
    assert labels == ["Later", "Publish"]


def test_skip_and_publish_sends_the_summary_and_a_skipped_gate(page):
    page.evaluate("() => openGitPublish()")
    page.wait_for_selector("#git-publish-summary")
    page.fill("#git-publish-summary", "  Fix the Sleep button  ")
    _gate(page, "skip")
    _click(page, "Publish")
    _until(page, "() => window.__posts.length === 1")
    post = page.evaluate("() => window.__posts[0]")
    assert post == {"action": "both", "confirm_branch": False,
                    "summary": "Fix the Sleep button", "gate": {"mode": "skipped"}}
    # The dialog shows the server's messages and the field state is reset.
    _until(page, "() => /Pushed\\./.test(document.getElementById('git-sync-body').textContent)")
    assert page.evaluate("() => [_publishSummary, _publishGate]") == ["", None]


def test_a_passing_run_records_its_counts_in_the_gate(page):
    page.evaluate("() => { window.__testDone = {ok: true, passed: 412, failed: 0, errors: 0, skipped: 3, seconds: 87, exit_code: 0}; }")
    page.evaluate("() => openGitPublish()")
    page.wait_for_selector("#git-publish-summary")
    _click(page, "Publish")   # Fast is the default
    _until(page, "() => window.__posts.length === 1")
    post = page.evaluate("() => window.__posts[0]")
    assert post["summary"] == ""
    assert post["gate"] == {"mode": "fast", "passed": 412, "skipped": 3, "failed": 0,
                            "seconds": 87, "anyway": False}


def test_publish_anyway_after_failures_marks_the_gate(page):
    page.evaluate("() => { window.__testDone = {ok: false, passed: 400, failed: 1, errors: 1, skipped: 0, seconds: 90, exit_code: 1}; }")
    page.evaluate("() => openGitPublish()")
    page.wait_for_selector("#git-publish-summary")
    page.fill("#git-publish-summary", "Risky")
    _gate(page, "full")
    _click(page, "Publish")
    _until(page, "() => /Not published/.test(document.getElementById('git-sync-title').textContent)")
    assert page.evaluate("() => window.__posts.length") == 0, "a failed gate must not publish by itself"
    _click(page, "Publish anyway")
    _until(page, "() => window.__posts.length === 1")
    post = page.evaluate("() => window.__posts[0]")
    assert post["summary"] == "Risky"
    assert post["gate"] == {"mode": "full", "passed": 400, "skipped": 0, "failed": 2,
                            "seconds": 90, "anyway": True}


def test_minimized_during_the_tests_stays_minimized_through_the_upload(page):
    """A publish is one job: Minimize pressed while the tests run must hold
    through the scan and upload, not pop the dialog back up for phase two."""
    page.evaluate("""() => {
      window.__finishTests = null;
      _streamTestRun = (mode, h) => { window.__finishTests = () => h.onDone(
        {mode, ok: true, passed: 12, failed: 0, errors: 0, skipped: 0, seconds: 5, exit_code: 0}, ['....']); };
    }""")
    page.evaluate("() => openGitPublish()")
    page.wait_for_selector("#git-publish-summary")
    _click(page, "Publish")
    _until(page, "() => !!window.__finishTests")
    assert [b.strip() for b in page.locator("#git-sync-actions button").all_text_contents()] == ["Minimize"]
    _click(page, "Minimize")
    page.evaluate("() => window.__finishTests()")
    shown = "() => document.getElementById('git-sync-overlay').classList.contains('show')"
    _until(page, "() => window.__posts.length === 1")   # phase two ran
    assert not page.evaluate(shown), "the dialog popped back up for the upload"
    _until(page, "() => /Published/.test(document.getElementById('git-sync-mini-label').textContent)")
    assert not page.evaluate(shown)


def test_a_pull_that_installed_dependencies_says_so(page):
    page.evaluate("() => { window.__syncResult = {ok: true, messages: ['Pulled latest VibeNode updates from remote.', 'Installed 2 new or updated dependencies.'], pip_ran: true, pip_ok: true, pip_installed: 2, git_status: {ahead: 0, behind: 0}}; }")
    page.evaluate("() => executeGitAction('pull', 'btn-git-update', 'Update App')")
    _until(page, "() => window.__toasts.length === 1")
    assert page.evaluate("() => window.__toasts") == ["Installed 2 new dependencies"]
    assert "Installed 2 new or updated dependencies." in page.locator("#git-sync-body").text_content()


def test_a_failed_dependency_install_shows_pips_output(page):
    page.evaluate("() => { window.__syncResult = {ok: true, messages: ['Pulled latest VibeNode updates from remote.', 'Dependency install failed; see the pip output below.'], pip_ran: true, pip_ok: false, pip_installed: 0, pip_output_tail: 'ERROR: No matching distribution found for nope', git_status: {ahead: 0, behind: 0}}; }")
    page.evaluate("() => executeGitAction('pull', 'btn-git-update', 'Update App')")
    _until(page, "() => window.__toasts.length === 1")
    assert "Dependency install failed" in page.evaluate("() => window.__toasts[0]")
    _until(page, "() => /No matching distribution/.test(document.getElementById('git-sync-body').textContent)")


def test_a_clash_is_not_a_security_issue_and_offers_fix_with_ai(page):
    """An Update whose pull clashed with local changes must offer a way to
    get it fixed: the same Fix with AI as a scan finding, and the session it
    opens names the clashed files."""
    page.evaluate("""() => {
      window.__syncResult = {ok: false, conflicts: ['tests/test_card_answered.py'],
        messages: ['Pulled the update, but your local changes clashed with it in: tests/test_card_answered.py.',
                   'Nothing was published.']};
      window.__fix = null;
      _startFixSession = (title, preview, prompt) => { window.__fix = {title, prompt}; };
    }""")
    page.evaluate("() => executeGitAction('both', 'btn-git-publish', 'Publish App Update')")
    _until(page, "() => /changes clash/i.test(document.getElementById('git-sync-title').textContent)")
    assert "Security" not in page.locator("#git-sync-title").text_content()
    _click(page, "Fix with AI")
    fix = page.evaluate("() => window.__fix")
    assert fix["title"] == "Resolve Update Clash"
    assert "tests/test_card_answered.py" in fix["prompt"]
    assert "Do NOT make new commits or push" in fix["prompt"]
    assert "git pull --rebase" not in fix["prompt"]   # a stash clash: markers are on disk


def test_a_clash_in_the_pull_itself_tells_the_session_to_redo_the_pull(page):
    """The pull was undone (src/web/git_ops.py `pull_clash`), so there are no
    markers yet: the session must redo the pull, and never with -X theirs."""
    page.evaluate("""() => {
      window.__syncResult = {ok: false, conflicts: ['src/web/static/js/last-card.js'], pull_clash: true,
        messages: ['The update clashes with your saved changes in: static/js/last-card.js.']};
      window.__fix = null;
      _startFixSession = (title, preview, prompt) => { window.__fix = {title, prompt}; };
    }""")
    page.evaluate("() => executeGitAction('both', 'btn-git-publish', 'Publish App Update')")
    _until(page, "() => /changes clash/i.test(document.getElementById('git-sync-title').textContent)")
    _click(page, "Fix with AI")
    prompt = page.evaluate("() => window.__fix.prompt")
    assert "git pull --rebase" in prompt and "never with -X theirs" in prompt


def test_publishing_shows_the_work_as_it_happens(page):
    """The server names its steps, says when each starts and what it is doing
    inside it (/api/git-sync-stream).  The dialog shows the step, git's own
    live line, a checklist with times, and a ring and percentage that follow
    the reported counts; it never sits on a spinner."""
    page.evaluate("""() => {
      const enc = new TextEncoder();
      window.__push = null;
      window.__stream = new ReadableStream({start(c) { window.__push = l => c.enqueue(enc.encode(JSON.stringify(l) + String.fromCharCode(10))); window.__end = () => c.close(); }});
    }""")
    page.evaluate("() => { executeGitAction('push', 'btn-git-publish', 'Publish App Update'); }")   # not awaited: it ends when the stream does
    _until(page, "() => window.__push && window.__posts.length === 1")
    page.evaluate("""() => {
      __push({type: 'steps', steps: [{key: 'scan', label: 'Checking files for keys'},
        {key: 'save', label: 'Saving a new version'}, {key: 'upload', label: 'Uploading'}]});
      __push({type: 'step', key: 'scan'});
      __push({type: 'detail', key: 'scan', text: 'Checked 270 of 540 files · src/web/app.py', pct: 50});
    }""")
    _until(page, "() => /Checked 270 of 540 files/.test(document.getElementById('scan-progress-text').textContent)")
    assert page.locator("#gs-big").text_content() == "16%"            # half of the first of three steps
    page.clock.run_for(2000)
    assert page.locator("#gs-big").text_content() == "16%", "a reported count is shown as it is, not eased"
    page.evaluate("""() => { __push({type: 'step', key: 'upload'});
      __push({type: 'detail', key: 'upload', text: 'Uploading 9 of 20 · 1.20 MiB · 300.00 KiB/s', pct: 45}); }""")
    _until(page, "() => /Uploading 9 of 20/.test(document.getElementById('scan-progress-text').textContent)")
    assert page.locator("#sync-step-label").text_content() == "Uploading"
    assert page.locator("#gs-big").text_content() == "81%"            # two steps done, 45% of the third
    steps = page.locator("#gs-steps li")
    assert [steps.nth(i).get_attribute("class") for i in range(3)] == ["gs-st done", "gs-st done", "gs-st cur"]
    clock = page.locator("#gs-step-clock").text_content()
    page.clock.run_for(2000)
    assert page.locator("#gs-step-clock").text_content() != clock, "the running step's clock ticks"
    assert "so far" in page.locator("#gs-total-clock").text_content()
    full = 2 * 3.141592653589793 * 52
    off = float(page.get_attribute("#gs-ring", "stroke-dashoffset"))
    assert abs((1 - off / full) - 0.8166) < 0.01
    assert page.evaluate("() => document.querySelectorAll('.gs-spin').length") == 0
    # Minimized, the pill shows the same progress: a filled ring and a percentage, no spinner.
    # While it runs, the dialog's one bottom action is a primary Minimize button.
    labels = [b.strip() for b in page.locator("#git-sync-actions button").all_text_contents()]
    assert labels == ["Minimize"]
    assert page.locator("#git-sync-actions .pm-btn-primary").count() == 1
    _click(page, "Minimize")
    page.clock.run_for(600)
    assert page.locator("#git-sync-mini-pct").text_content() == "81%"
    assert page.locator("#git-sync-mini-spinner.working").count() == 0
    assert page.evaluate("() => document.getElementById('git-sync-mini-bar-fill').style.width").startswith("81")
    assert page.locator(".git-sync-mini-bar.run").count() == 1
    page.evaluate("""() => { __push({type: 'done', result: {ok: true, messages: ['Pushed.'],
      git_status: {ahead: 0, behind: 0, uncommitted: false}}}); __end(); }""")
    _until(page, "() => /Published/.test(document.getElementById('git-sync-mini-label').textContent)")
    assert page.locator("#git-sync-mini-spinner.done").count() == 1
    assert page.locator(".git-sync-mini-bar.ok").count() == 1


def test_the_publish_dialog_code_refreshes_in_an_open_tab():
    src = (ROOT / "src" / "web" / "static" / "js" / "live-assets.js").read_text(encoding="utf-8")
    assert "'js/git-sync.js'" in src


# ── The release notes sheet (the real card markup from index.html) ──

CHANGES = {"incoming": {"files": 6, "notes": [], "areas": [
               {"name": "Session list", "what": "the sidebar and its statuses", "files": 4},
               {"name": "Tests", "what": "checks that guard the app", "files": 2}]},
           "outgoing": {"files": 9, "notes": ["Make the Sleep button stick"], "areas": [
               {"name": "Chat", "what": "the conversation and the text box", "files": 5},
               {"name": "Web server", "what": "the services behind the app", "files": 2},
               {"name": "Start and stop", "what": "launching, starting at sign-in and recovery", "files": 1},
               {"name": "Tests", "what": "checks that guard the app", "files": 1}]}}


def _sheet_html() -> str:
    """The test page with the dialog's real card from index.html and /api/git-changes answered."""
    html = _page_html()
    tpl = (ROOT / "src" / "web" / "templates" / "index.html").read_text(encoding="utf-8")
    a = tpl.index('<div class="overlay" id="git-sync-overlay">')
    b = tpl.index("<!-- Minimized git sync floating indicator -->")
    start = html.index('<div class="overlay" id="git-sync-overlay">')
    end = html.index('<div id="git-sync-mini">')
    html = html[:start] + tpl[a:b] + html[end:]
    return html.replace("else if (url === '/api/git-status')",
                        "else if (url === '/api/git-changes') body = " + json.dumps(CHANGES) + ";\n    else if (url === '/api/git-status')")


@pytest.fixture
def sheet(browser):
    pg = browser.new_page(viewport={"width": 1100, "height": 800})
    pg.clock.install()
    pg.set_content(_sheet_html())
    yield pg
    pg.close()


def test_publish_draws_as_a_sheet_with_what_goes_out(sheet):
    sheet.evaluate("() => openGitPublish()")
    _until(sheet, "() => document.querySelector('#gs-notes-box .gs-notes')")
    assert sheet.locator("#git-sync-card.gs-sheet").count() == 1
    notes = [t.strip() for t in sheet.locator("#gs-notes-box .gs-notes li > span:last-child").all_inner_texts()]
    # A title someone wrote comes first, then the biggest areas; the rest fold into one row.
    assert notes[0] == "Make the Sleep button stick"
    assert notes[1].startswith("Chat") and "5 files" in notes[1]
    assert notes[-1].startswith("2 more areas")
    assert len(notes) == 4
    assert sheet.locator("#git-sync-side .gs-side-num").first.text_content() == "9"
    assert sheet.locator("#git-sync-side .gs-side-lbl").first.text_content() == "files"
    assert "gs-bar run" not in (sheet.get_attribute("#git-sync-bar", "class") or "")


def test_the_sheets_number_and_bar_follow_the_run(sheet):
    sheet.evaluate("""() => { const enc = new TextEncoder();
      window.__stream = new ReadableStream({start(c) { window.__push = l => c.enqueue(enc.encode(JSON.stringify(l) + String.fromCharCode(10))); window.__end = () => c.close(); }}); }""")
    sheet.evaluate("() => { executeGitAction('push', 'btn-git-publish', 'Publish App Update'); }")
    _until(sheet, "() => window.__push && window.__posts.length === 1")
    sheet.evaluate("""() => { __push({type: 'steps', steps: [{key: 'scan', label: 'Checking'}, {key: 'up', label: 'Uploading'}]});
      __push({type: 'step', key: 'up'}); __push({type: 'detail', key: 'up', text: 'Uploading', pct: 50}); }""")
    _until(sheet, "() => document.getElementById('gs-side-big') && document.getElementById('gs-side-big').textContent === '75%'")
    assert sheet.get_attribute("#git-sync-bar", "class") == "gs-bar run"
    width = sheet.evaluate("() => document.querySelector('#git-sync-bar > i').style.width")
    assert width == "75%"
    labels = [b.strip() for b in sheet.locator("#git-sync-actions button").all_text_contents()]
    assert labels == ["Keep working, notify me when done"]
    sheet.evaluate("""() => { __push({type: 'done', result: {ok: true, messages: ['Pushed.'],
      git_status: {ahead: 0, behind: 0, uncommitted: false}}}); __end(); }""")
    _until(sheet, "() => document.getElementById('git-sync-title').textContent === 'Published'")
    assert sheet.get_attribute("#git-sync-side", "class") == "gs-side ok"
    assert sheet.get_attribute("#git-sync-bar", "class") == "gs-bar ok"


def test_other_users_of_the_dialog_keep_the_plain_card(sheet):
    sheet.evaluate("() => { openGitUpdate(); closeGitSyncModal(); showGitSyncModal('Security scan', '<p>x</p>', [{label: 'OK', onclick: closeGitSyncModal}]); }")
    assert sheet.locator("#git-sync-card.gs-sheet").count() == 0



# ── A reload mid-run brings the pill back (the run lives on the server) ──

_ORIGIN = "http://publish.test/"


def _served_page(browser, html):
    """The page from a real origin, so localStorage survives a reload."""
    pg = browser.new_page(viewport={"width": 1100, "height": 700})
    pg.route(_ORIGIN, lambda route: route.fulfill(status=200, content_type="text/html", body=html))
    pg.clock.install()
    pg.goto(_ORIGIN)
    return pg


def _job_html() -> str:
    """The test page, with /api/git-sync-job answered from window.__jobReply
    (kept in sessionStorage so a test can set it for the next load) and the
    test stream recording the run id it reattaches to."""
    html = _page_html()
    html = html.replace("if (url === '/api/test-modes')",
        "if (String(url).indexOf('/api/git-sync-job') === 0) { var j = sessionStorage.getItem('jobReply');"
        " if (!j) return Promise.resolve({ok: false, json: () => Promise.resolve({})});"
        " body = JSON.parse(j); }\n    else if (url === '/api/test-modes')")
    return html.replace("function _streamTestRun(mode, h) {",
        "function _streamTestRun(mode, h) { window.__reattached = h.runId || null; if (h.runId) return;")


def test_a_minimized_upload_comes_back_as_the_pill_after_a_reload(browser):
    pg = _served_page(browser, _job_html())
    try:
        pg.evaluate("""() => { localStorage.clear(); const enc = new TextEncoder();
          window.__stream = new ReadableStream({start(c) { window.__push = l => c.enqueue(enc.encode(JSON.stringify(l) + String.fromCharCode(10))); }});
          executeGitAction('push', 'btn-git-publish', 'Publish App Update'); }""")
        _until(pg, "() => window.__push && window.__posts.length === 1")
        pg.evaluate("""() => { __push({type: 'steps', job: 'job1', steps: [{key: 'scan', label: 'Checking'}, {key: 'up', label: 'Uploading'}]});
          __push({type: 'step', key: 'up'}); }""")
        _until(pg, "() => (JSON.parse(localStorage.getItem('vnGitSyncJob') || '{}')).jobId === 'job1'")
        pg.evaluate("() => minimizeGitSyncModal()")
        assert pg.evaluate("() => JSON.parse(localStorage.getItem('vnGitSyncJob')).phase") == "sync"
        # The server is still uploading when the page comes back.
        pg.evaluate("""() => sessionStorage.setItem('jobReply', JSON.stringify({job: 'job1', count: 2, done: false, result: null,
          steps: [{key: 'scan', label: 'Checking'}, {key: 'up', label: 'Uploading'}],
          events: [{type: 'step', key: 'up'}, {type: 'detail', key: 'up', text: 'Uploading', pct: 40}]}))""")
        pg.reload()
        _until(pg, "() => document.getElementById('git-sync-mini').classList.contains('show')")
        assert pg.locator("#git-sync-overlay.show").count() == 0
        _until(pg, "() => document.getElementById('git-sync-mini-label').textContent === 'Uploading'")
        # It finishes: the pill says so, and a further reload still shows it until dismissed.
        pg.evaluate("""() => sessionStorage.setItem('jobReply', JSON.stringify({job: 'job1', count: 3, done: true,
          steps: [], events: [], result: {ok: true, messages: ['Pushed.'], git_status: {ahead: 0, behind: 0, uncommitted: false}}}))""")
        _until(pg, "() => /Published/.test(document.getElementById('git-sync-mini-label').textContent)")
        assert pg.locator("#git-sync-mini-spinner.done").count() == 1
        pg.reload()
        _until(pg, "() => /Published/.test(document.getElementById('git-sync-mini-label').textContent)")
        pg.evaluate("() => dismissGitSyncMini()")
        assert pg.evaluate("() => localStorage.getItem('vnGitSyncJob')") is None
    finally:
        pg.close()


def test_a_reload_during_the_tests_reattaches_to_the_same_run(browser):
    pg = _served_page(browser, _job_html())
    try:
        pg.evaluate("""() => { localStorage.clear(); localStorage.setItem('vnGitSyncJob', JSON.stringify({phase: 'tests', mode: 'fast',
          actionType: 'publish', actionLabel: 'Publish App Update', btnId: 'btn-git-publish', runId: 'run42', at: Date.now()})); }""")
        pg.reload()
        _until(pg, "() => window.__reattached === 'run42'")
        assert pg.evaluate("() => document.getElementById('git-sync-mini').classList.contains('show')")
    finally:
        pg.close()


def test_an_old_finished_or_stale_run_is_not_brought_back(browser):
    pg = _served_page(browser, _job_html())
    try:
        pg.evaluate("""() => localStorage.setItem('vnGitSyncJob', JSON.stringify({phase: 'sync', at: Date.now() - 4 * 3600 * 1000}))""")
        pg.reload()
        pg.clock.run_for(500)
        assert not pg.evaluate("() => document.getElementById('git-sync-mini').classList.contains('show')")
        assert pg.evaluate("() => localStorage.getItem('vnGitSyncJob')") is None
    finally:
        pg.close()

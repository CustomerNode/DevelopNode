"""A Validate page that lands on a sign-in page leaves the user a job: sign in
before trying anything.  Smart termination loads a Validate page on another
port of this machine the way a signed-out visitor would, but only when the
user's own browsers hold no sign-in cookie for that host, and sends the card
back when it ends on a sign-in page.  Sign-in work may link the sign-in page."""
import http.server
import json
import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from engine import handoff_rules as hr  # noqa: E402

PAGES = {
    "/gated/": (302, {"Location": "/accounts/login/?next=/gated/"}, ""),
    "/accounts/login/": (200, {}, '<form><input name="u"><input type="password" name="p"></form>'),
    "/open/": (200, {}, "<h1>Garden planner</h1>"),
    "/app/": (200, {}, "<div id=root></div><script>location.replace('/accounts/login/')</script>"),
    "/app-open/": (200, {}, "<div id=root></div><script>document.body.append('ready')</script>"),
}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        code, headers, body = PAGES.get(self.path.split("?")[0], (404, {}, "no"))
        self.send_response(code)
        self.send_header("Content-Type", "text/html")
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture(autouse=True)
def _on(monkeypatch):
    monkeypatch.setenv("VIBENODE_LINK_CHECK", "1")
    monkeypatch.setenv("VIBENODE_SIGNIN_CHECK", "1")
    monkeypatch.setattr(hr, "_signin_cache", {})
    monkeypatch.setattr(hr, "_signed_in_hosts", lambda: set())


def _card(url, **extra):
    c = {"type": "done", "title": "Garden planner", "headline": "Beds page shows the planting grid.",
         "zoom": {"big": "Garden planner", "task": "Planting grid", "now": "Grid added"},
         "validate": {"how": "Open it and drag a bed.", "url": url}}
    c.update(extra)
    return c


def test_a_page_that_redirects_to_sign_in_is_sent_back(server):
    probs = hr.signin_wall_problems(_card(server + "/gated/"))
    assert probs and "sign-in page" in probs[0] and "/accounts/login/" in probs[0]
    review = hr.review("```handoff\n" + json.dumps(_card(server + "/gated/")) + "\n```") or ""
    assert "sign-in page" in review


def test_an_open_page_passes(server):
    assert hr.signin_wall_problems(_card(server + "/open/")) == []


def test_the_sign_in_page_itself_passes(server):
    assert hr.signin_wall_problems(_card(server + "/accounts/login/")) == []


def test_sign_in_work_may_land_on_sign_in(server):
    card = _card(server + "/gated/", title="Sign-in form", zoom={"big": "x", "task": "Fix the login redirect", "now": "y"})
    assert hr.signin_wall_problems(card) == []


def test_a_port_the_users_browser_is_signed_in_to_is_never_loaded(server, monkeypatch):
    monkeypatch.setattr(hr, "_signed_in_hosts", lambda: {"127.0.0.1"})
    monkeypatch.setattr(hr, "_visited_past_signin", lambda origin: origin == server)
    monkeypatch.setattr(hr, "_lands_on_signin", lambda url: pytest.fail("loaded a signed-in page"))
    assert hr.signin_wall_problems(_card(server + "/gated/")) == []


def test_a_second_copy_on_a_new_port_is_still_checked(server, monkeypatch):
    # The host's cookie came from the copy the user uses on another port;
    # this port was never opened past its sign-in page.
    monkeypatch.setattr(hr, "_signed_in_hosts", lambda: {"127.0.0.1"})
    monkeypatch.setattr(hr, "_visited_past_signin", lambda origin: False)
    assert hr.signin_wall_problems(_card(server + "/gated/"))


def test_history_counts_only_this_port_past_its_sign_in(tmp_path, monkeypatch):
    prof = tmp_path / "Default"
    prof.mkdir()
    (prof / "Cookies").write_bytes(b"")
    con = sqlite3.connect(prof / "History")
    con.execute("CREATE TABLE urls (url TEXT)")
    con.executemany("INSERT INTO urls VALUES (?)", [
        ("http://127.0.0.1:7100/beds/3",), ("http://127.0.0.1:7200/accounts/login/?next=/beds/",),
        ("http://127.0.0.1:71000/beds/",)])
    con.commit()
    con.close()
    monkeypatch.setattr(hr, "_browser_cookie_dbs", lambda: [prof / "Cookies"])
    assert hr._visited_past_signin("http://127.0.0.1:7100")
    assert not hr._visited_past_signin("http://127.0.0.1:7200")
    assert not hr._visited_past_signin("http://127.0.0.1:7300")
    assert not hr._visited_past_signin("http://127.0.0.1:710")


def test_unreadable_browsers_judge_nothing(server, monkeypatch):
    monkeypatch.setattr(hr, "_signed_in_hosts", lambda: None)
    assert hr.signin_wall_problems(_card(server + "/gated/")) == []


def test_vibenode_and_outside_addresses_are_not_loaded(monkeypatch):
    monkeypatch.setattr(hr, "_lands_on_signin", lambda url: pytest.fail("loaded " + url))
    for url in ("http://127.0.0.1:5050/static/scratch/x.html", "https://example.org/login-wall", "/static/x.html"):
        assert hr.signin_wall_problems(_card(url)) == []


def test_the_switches_turn_it_off(server, monkeypatch):
    monkeypatch.setenv("VIBENODE_SIGNIN_CHECK", "0")
    assert hr.signin_wall_problems(_card(server + "/gated/")) == []
    monkeypatch.setenv("VIBENODE_SIGNIN_CHECK", "1")
    monkeypatch.setenv("VIBENODE_LINK_CHECK", "0")
    assert hr.signin_wall_problems(_card(server + "/gated/")) == []


def test_signed_in_hosts_reads_cookie_names_only(tmp_path, monkeypatch):
    monkeypatch.undo()
    db = tmp_path / "Cookies"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB)")
    con.executemany("INSERT INTO cookies VALUES (?, ?, ?)", [
        ("localhost", "sessionid", b"v11..."), ("127.0.0.1", "csrftoken", b"v11..."),
        ("127.0.0.1", "planner_device", b"v11..."), (".garden.test", "auth_token", b"v11...")])
    con.commit()
    con.close()
    monkeypatch.setattr(hr, "_browser_cookie_dbs", lambda: [db])
    assert hr._signed_in_hosts() == {"localhost", "garden.test"}
    monkeypatch.setattr(hr, "_browser_cookie_dbs", lambda: [])
    assert hr._signed_in_hosts() is None


def _has_browser():
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            p.chromium.launch().close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _has_browser(), reason="needs Playwright with Chromium")
def test_a_script_redirect_to_sign_in_is_caught_by_the_browser(server):
    probs = hr.signin_wall_problems(_card(server + "/app/"))
    assert probs and "/accounts/login/" in probs[0]
    assert hr.signin_wall_problems(_card(server + "/app-open/")) == []


# A gated address wrapped in a page of this app that frames it shows the user
# the same sign-in page, so the framed address is judged; so are the other
# places a card asks the user to open a page.
def _wrapper(tmp_path, monkeypatch, body):
    static = tmp_path / "static"
    (static / "scratch").mkdir(parents=True)
    (static / "scratch" / "beds-live.html").write_text(body, encoding="utf-8")
    monkeypatch.setattr(hr, "_STATIC_DIR", static)
    return "/static/scratch/beds-live.html"


def test_a_page_that_frames_a_gated_address_is_sent_back(server, tmp_path, monkeypatch):
    page = _wrapper(tmp_path, monkeypatch,
                    f'<html><body><iframe data-keep src="{server}/gated/"></iframe></body></html>')
    probs = hr.signin_wall_problems(_card(page))
    assert probs and "frames it" in probs[0] and "/accounts/login/" in probs[0]


def test_a_page_that_sets_its_frame_in_script_is_judged_too(server, tmp_path, monkeypatch):
    page = _wrapper(tmp_path, monkeypatch,
                    f"<iframe id=f></iframe><script>f.src = '{server}/gated/';</script>")
    assert hr.signin_wall_problems(_card(page))


def test_a_page_that_frames_an_open_address_passes(server, tmp_path, monkeypatch):
    page = _wrapper(tmp_path, monkeypatch, f'<iframe src="{server}/open/"></iframe>')
    assert hr.signin_wall_problems(_card(page)) == []


def test_a_note_in_a_comment_is_not_a_frame(server, tmp_path, monkeypatch):
    page = _wrapper(tmp_path, monkeypatch,
                    f'<!-- was <iframe src="{server}/gated/"> --><iframe src="{server}/open/"></iframe>')
    assert hr.signin_wall_problems(_card(page)) == []


def test_sign_in_work_may_frame_the_sign_in_wall(server, tmp_path, monkeypatch):
    page = _wrapper(tmp_path, monkeypatch, f'<iframe src="{server}/gated/"></iframe>')
    card = _card(page, title="Login redirect", zoom={"big": "x", "task": "Fix the login redirect", "now": "y"})
    assert hr.signin_wall_problems(card) == []


def test_a_gated_page_to_look_at_or_link_is_sent_back(server):
    look = _card("/static/x.html", needs={"kind": "none", "look": [{"label": "Beds", "kind": "link",
                                                                   "url": server + "/gated/"}]})
    assert any(p.startswith("needs.look") for p in hr.signin_wall_problems(look))
    link = _card("/static/x.html", links=[{"label": "Beds", "kind": "link", "url": server + "/gated/"}])
    assert any(p.startswith("links") for p in hr.signin_wall_problems(link))


def test_a_picture_is_never_loaded_as_a_page(monkeypatch):
    monkeypatch.setattr(hr, "_lands_on_signin", lambda url: pytest.fail("loaded " + url))
    card = _card("/static/x.html", links=[{"label": "Before", "kind": "image",
                                           "url": "http://127.0.0.1:7999/shot.png"}])
    assert hr.signin_wall_problems(card) == []


def test_a_locked_cookie_store_lets_history_decide(server, tmp_path, monkeypatch):
    # A running browser can hold its cookie store locked; its sign-ins are
    # then unknown, and having been past this port's sign-in page decides.
    monkeypatch.undo()
    monkeypatch.setenv("VIBENODE_LINK_CHECK", "1")
    monkeypatch.setenv("VIBENODE_SIGNIN_CHECK", "1")
    monkeypatch.setattr(hr, "_signin_cache", {})
    locked = tmp_path / "Profile" / "Cookies"
    locked.parent.mkdir()
    locked.write_bytes(b"not a database")
    monkeypatch.setattr(hr, "_browser_cookie_dbs", lambda: [locked])
    assert hr.UNREAD_STORE in hr._signed_in_hosts()
    monkeypatch.setattr(hr, "_visited_past_signin", lambda origin: origin == server)
    monkeypatch.setattr(hr, "_lands_on_signin", lambda url: pytest.fail("loaded a page the user got into"))
    assert hr.signin_wall_problems(_card(server + "/gated/")) == []
    monkeypatch.setattr(hr, "_visited_past_signin", lambda origin: False)
    monkeypatch.setattr(hr, "_lands_on_signin", lambda url: url + "accounts/login/")
    assert hr.signin_wall_problems(_card(server + "/gated/"))

"""DevelopNode shown inside developnode.com/app (the main script's in-site block).

Runs the real block from the main app script in a page framed by a stand-in for
the site, in headless Chromium, and checks what the site relies on: the app
reports its address and title, hides its own splash and says when it is ready,
and its logo goes to developnode.com. Outside the site none of that happens.
"""
import json
import pathlib
import re

import pytest

pw = pytest.importorskip("playwright.sync_api")

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "src" / "web" / "static" / "js" / "app.js").read_text(encoding="utf-8")
START = APP_JS.index("// Shown inside developnode.com/app")
BLOCK = APP_JS[START:]
CHILD_ORIGIN = "http://127.0.0.1:5999"

PARENT = """<!doctype html><body><script>
window.got = [];
addEventListener('message', e => { if (e.origin === '%s') got.push(e.data); });
</script><iframe id="f" src="%s/child"></iframe></body>""" % (CHILD_ORIGIN, CHILD_ORIGIN)

CHILD = """<!doctype html><title>Sessions</title><body>
<div id="vn-splash" class="vn-splash"></div>
<h1 class="dn-lockup" onclick="window.homeView = true">DevelopNode</h1>
<script>%s</script></body>""" % BLOCK


def test_the_block_is_the_last_thing_in_the_script():
    assert BLOCK.rstrip().endswith("})();")
    assert "window.top.location.href = 'https://developnode.com/'" in BLOCK


@pytest.fixture()
def browser():
    with pw.sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def _framed(browser):
    ctx = browser.new_context()
    ctx.grant_permissions(["local-network-access"], origin="https://developnode.com")
    page = ctx.new_page()
    page.route("https://developnode.com/app", lambda r: r.fulfill(body=PARENT, content_type="text/html"))
    page.route("https://developnode.com/", lambda r: r.fulfill(body="<title>site home</title>", content_type="text/html"))
    page.route(CHILD_ORIGIN + "/child", lambda r: r.fulfill(body=CHILD, content_type="text/html"))
    page.goto("https://developnode.com/app")
    page.wait_for_function("got.some(m => m.type === 'dn:url')")
    return page, page.frame_locator("#f"), next(f for f in page.frames if f.url.startswith(CHILD_ORIGIN))


def test_reports_address_and_title_to_the_site(browser):
    page, _, child = _framed(browser)
    assert {"type": "dn:url", "url": "/child", "title": "Sessions"} in page.evaluate("got")
    child.evaluate("history.pushState({}, '', '/?chat=abc#x'); document.title = 'A chat'")
    page.wait_for_function("got.some(m => m.url === '/?chat=abc#x' && m.title === 'A chat')")


def test_hides_its_splash_and_says_ready_only_when_it_would_lift(browser):
    page, _, child = _framed(browser)
    assert child.evaluate("document.getElementById('vn-splash').style.visibility") == "hidden"
    page.wait_for_timeout(300)
    assert not any(m.get("type") == "dn:ready" for m in page.evaluate("got"))
    child.evaluate("document.getElementById('vn-splash').classList.add('ready')")
    page.wait_for_function("got.some(m => m.type === 'dn:ready')")


def test_ready_at_once_when_the_splash_is_already_gone(browser):
    ctx = browser.new_context()
    ctx.grant_permissions(["local-network-access"], origin="https://developnode.com")
    page = ctx.new_page()
    page.route("https://developnode.com/app", lambda r: r.fulfill(body=PARENT, content_type="text/html"))
    page.route(CHILD_ORIGIN + "/child", lambda r: r.fulfill(body=CHILD.replace('<div id="vn-splash" class="vn-splash"></div>', ""), content_type="text/html"))
    page.goto("https://developnode.com/app")
    page.wait_for_function("got.some(m => m.type === 'dn:ready')")


def test_logo_goes_to_the_site(browser):
    page, frame, child = _framed(browser)
    frame.locator(".dn-lockup").click()
    page.wait_for_url("https://developnode.com/")
    assert page.title() == "site home"


def test_outside_the_site_nothing_changes(browser):
    page = browser.new_page()
    page.route(CHILD_ORIGIN + "/child", lambda r: r.fulfill(body=CHILD, content_type="text/html"))
    page.goto(CHILD_ORIGIN + "/child")
    assert page.evaluate("document.getElementById('vn-splash').style.visibility") == ""
    page.click(".dn-lockup")
    assert page.evaluate("window.homeView") is True
    assert page.url == CHILD_ORIGIN + "/child"


def test_another_site_framing_it_gets_nothing(browser):
    ctx = browser.new_context()
    page = ctx.new_page()
    page.route("https://other.example/app", lambda r: r.fulfill(body=PARENT, content_type="text/html"))
    page.route(CHILD_ORIGIN + "/child", lambda r: r.fulfill(body=CHILD, content_type="text/html"))
    page.goto("https://other.example/app")
    page.wait_for_timeout(800)
    assert page.evaluate("got") == []

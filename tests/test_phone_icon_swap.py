"""An iPhone home-screen app from before the rename is shown how to swap its icon.

iOS keeps the picture it took when the icon was added, so an install from
before the rename must be re-added from Safari.  The head of index.html stamps
whether this install is old (it already had saved settings) or new; only an
old one is asked, and a re-added one never is.  Drives the real head stamp and
the real ``rebrand.js`` in headless Chromium with iOS's ``navigator.standalone``.
"""

import pathlib
import re

import pytest

from tests._browser import shared_browser_scope


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


ROOT = pathlib.Path(__file__).resolve().parents[1]
INDEX = (ROOT / "src/web/templates/index.html").read_text(encoding="utf-8")
STAMP = re.search(r"<script>try\{if\(!localStorage\.getItem\('vnIconGen'\).*?</script>", INDEX).group(0)
JS = (ROOT / "src/web/static/js/rebrand.js").read_text(encoding="utf-8")
ORIGIN = "https://phone.example.ts.net"
_n = [0]


def _open(browser, *, standalone, saved=None, path="/"):
    """Each page its own origin: a new install starts with empty storage."""
    _n[0] += 1
    origin = ORIGIN.replace("phone.", "phone%d." % _n[0])
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.add_init_script(
        "Object.defineProperty(navigator, 'standalone', {get: () => %s});"
        "window.fetch = () => new Promise(() => {});" % ("true" if standalone else "false"))
    if saved:
        page.add_init_script("if (!sessionStorage.seeded) { sessionStorage.seeded = 1; %s }"
                             % "".join("localStorage.setItem(%r, %r);" % kv for kv in saved.items()))
    html = "<!doctype html><html><head>%s</head><body><script>%s</script></body></html>" % (STAMP, JS)
    page.route(origin + "/**", lambda r: r.fulfill(status=200, content_type="text/html", body=html))
    page.goto(origin + path)
    page.evaluate("window.VNRebrand.phoneIcon(); window.VNRebrand.safariHint();")
    return page


def test_an_install_from_before_the_rename_is_shown_the_swap(browser):
    page = _open(browser, standalone=True, saved={"theme": "dark"})
    try:
        assert page.evaluate("localStorage.getItem('vnIconGen')") == "old"
        link = page.locator("#vn-rebrand [data-safari]")
        assert link.get_attribute("href") .startswith("x-safari-https://phone")
        assert link.get_attribute("href").endswith(".example.ts.net/?homescreen=1")
        assert page.locator("#vn-rebrand [data-copy]").count() == 1
    finally:
        page.close()


def test_a_new_install_already_has_the_icon_and_is_never_asked(browser):
    page = _open(browser, standalone=True)
    try:
        assert page.evaluate("localStorage.getItem('vnIconGen')") == "new"
        assert page.locator("#vn-rebrand").count() == 0
    finally:
        page.close()


def test_safari_points_at_share_and_drops_the_marker(browser):
    page = _open(browser, standalone=False, path="/?homescreen=1")
    try:
        assert "Add to Home Screen" in page.locator("#vn-rebrand").inner_text()
        assert page.evaluate("location.search") == ""
    finally:
        page.close()


def test_plain_safari_shows_nothing(browser):
    page = _open(browser, standalone=False)
    try:
        assert page.locator("#vn-rebrand").count() == 0
    finally:
        page.close()

"""A summary opens full screen from a large handle beside it.

- every summary in the thread gets one handle, placed just before it (the
  card clips its own overflow, so the handle cannot live inside it);
- the handle sits in the margin when there is room, inside the card's right
  edge when there is not;
- tapping it pins the SAME element over the window (its buttons keep
  working), Escape or the cross puts it back exactly where it was;
- a redraw never leaves two handles beside one summary.
"""
import json
from pathlib import Path

import pytest

from tests._browser import shared_browser_scope

ROOT = Path(__file__).resolve().parents[1]
LAST_CARD = ROOT / "src" / "web" / "static" / "js" / "last-card.js"
CSS = ROOT / "src" / "web" / "static" / "css" / "last-card.css"

CARD = {"type": "done", "title": "Search box", "headline": "The search box finds messages now.",
        "answer": "Type in Search and messages match too.", "context": "x",
        "needs": {"kind": "none", "why": "All in.", "next": "Nothing runs by itself."}}


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _open(browser, tmp_path, width):
    html = f"""<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="{CSS.as_uri()}">
<style>#live-log {{ height: 600px; overflow: auto; }} .msg-body {{ width: {width}px; }}</style></head><body><div id="live-log">
<div class="msg user"><div class="msg-body">Does search work now?</div></div>
<div class="msg asst"><div class="msg-body"><div class="vn-card-ph" data-card='{json.dumps(CARD)}'></div></div></div></div>
<script>var liveSessionId='s1abc', sessionKinds={{s1abc:'idle'}};
window.fetch=()=>Promise.resolve({{ok:true,status:200,json:()=>Promise.resolve({{}})}});</script>
<script src="{LAST_CARD.as_uri()}"></script>
<script>VNLastCard.renderIn(document.getElementById('live-log'));</script></body></html>"""
    f = tmp_path / "full.html"
    f.write_text(html, encoding="utf-8")
    page = browser.new_page(viewport={"width": 1000, "height": 700})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f.as_uri(), wait_until="load")
    page.wait_for_function("document.querySelectorAll('.lm-fs-ride').length === 1")
    assert not errors, errors
    return page


def test_the_handle_sits_beside_the_summary_and_opens_it_full_screen(browser, tmp_path):
    page = _open(browser, tmp_path, 600)
    try:
        assert page.evaluate("document.querySelector('.lm-fs-ride').nextElementSibling.matches('.lm.skim')")
        assert not page.evaluate("document.querySelector('.lm-fs-ride').classList.contains('in')")
        page.evaluate("window.__card = document.querySelector('#live-log .lm'); window.__home = __card.parentElement")
        page.locator(".lm-fs").click()
        page.wait_for_selector(".lm.lm-full")
        page.wait_for_function("document.querySelector('.lm-full').getAnimations().every(a => a.playState === 'finished')")
        box = page.evaluate("(() => { const r = document.querySelector('.lm-full').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
        assert box == [0, 0, 1000, 700]
        assert page.evaluate("document.querySelector('.lm-full') === window.__card")   # the same element, buttons and all
        assert page.evaluate("document.elementFromPoint(990, 690) && window.__card.contains(document.elementFromPoint(990, 690))")
        page.keyboard.press("Escape")
        page.wait_for_function("!document.querySelector('.lm-full')")
        assert page.evaluate("window.__card.parentElement === window.__home && !document.querySelector('.lm-full-x')")
        page.locator(".lm-fs").click()
        page.wait_for_selector(".lm-full-x")
        page.locator(".lm-full-x").click()
        page.wait_for_function("!document.querySelector('.lm-full')")
        assert page.evaluate("document.querySelectorAll('.lm-fs-ride').length") == 1
    finally:
        page.close()


def test_with_no_margin_the_handle_sits_inside_the_summary(browser, tmp_path):
    page = _open(browser, tmp_path, 990)
    try:
        assert page.evaluate("document.querySelector('.lm-fs-ride').classList.contains('in')")
        page.locator(".lm-fs").click()
        page.wait_for_selector(".lm.lm-full")
    finally:
        page.close()


def test_a_redraw_never_doubles_the_handle(browser, tmp_path):
    page = _open(browser, tmp_path, 600)
    try:
        page.evaluate("""() => { const c = document.querySelector('#live-log .lm'); const ph = document.createElement('div');
            ph.className = 'vn-card-ph'; ph.setAttribute('data-card', c.getAttribute('data-card')); c.replaceWith(ph);
            VNLastCard.renderIn(ph.parentElement); }""")
        page.wait_for_timeout(100)
        assert page.evaluate("document.querySelectorAll('.lm-fs-ride').length") == 1
        assert page.evaluate("document.querySelector('.lm-fs-ride').nextElementSibling.matches('.lm')")
    finally:
        page.close()

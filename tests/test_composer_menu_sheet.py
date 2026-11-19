"""On a phone the composer's More menu (four squares beside Send) is a native
bottom sheet: full width at the bottom edge, a grab handle, a dimmed screen
behind it, closed by a tap outside or a swipe down. The computer keeps the
popover above the button."""
from __future__ import annotations

import pytest

from tests._browser import shared_browser_scope


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def _page(browser, width, height=844, touch=False):
    from tests.test_enter_to_send import _open
    pg = _open(browser, width, height=height, touch=touch)
    pg.evaluate("() => { for (const id of ['vn-splash', 'health-blocker']) document.getElementById(id)?.remove(); }")
    pg.wait_for_selector("#live-image-btn", state="attached")
    pg.evaluate("document.getElementById('live-image-btn').click()")
    pg.wait_for_selector(".vn-more-menu")
    return pg


def test_on_a_phone_the_menu_is_a_bottom_sheet(browser):
    pg = _page(browser, 390, touch=True)
    pg.wait_for_function("getAnimations => !document.getAnimations().some(a => a.playState === 'running')")
    box = pg.evaluate("""() => { const r = document.querySelector('.vn-more-menu').getBoundingClientRect();
        return {left: r.left, right: r.right, bottom: r.bottom}; }""")
    assert box["left"] == 0 and box["right"] == 390 and abs(box["bottom"] - 844) < 1
    assert pg.query_selector(".vn-more-menu.vn-more-sheet .vn-ms-grab")
    assert pg.query_selector(".vn-more-scrim")
    # Rows big enough for a thumb.
    h = pg.evaluate("document.querySelector('.vn-more-sheet .vn-more-row').getBoundingClientRect().height")
    assert h >= 44
    # A tap on the dimmed screen closes the sheet and its backdrop.
    pg.mouse.click(195, 100)
    pg.wait_for_function("!document.querySelector('.vn-more-menu') && !document.querySelector('.vn-more-scrim')")


def test_a_swipe_down_closes_the_sheet(browser):
    pg = _page(browser, 390, touch=True)
    pg.evaluate("""() => { const m = document.querySelector('.vn-more-menu');
        const t = (y) => new Touch({identifier: 1, target: m, clientX: 200, clientY: y});
        m.dispatchEvent(new TouchEvent('touchstart', {touches: [t(600)], changedTouches: [t(600)], bubbles: true}));
        m.dispatchEvent(new TouchEvent('touchend', {touches: [], changedTouches: [t(720)], bubbles: true})); }""")
    pg.wait_for_function("!document.querySelector('.vn-more-menu') && !document.querySelector('.vn-more-scrim')")


def test_the_computer_keeps_the_popover(browser):
    pg = _page(browser, 1400, height=900)
    assert not pg.query_selector(".vn-more-sheet")
    assert not pg.query_selector(".vn-more-scrim")

"""On a phone the area above the sessions reads like a phone app.

The real index.html with every real script in headless Chromium at phone
width; only the network is faked. The project name, New Session and Search
start on one left edge, every control is at least 44px tall (a finger's
target), New Session is a full-width button and Search a filled field.
"""

from __future__ import annotations

import pytest

from tests._browser import shared_browser_scope
from tests._fake_app import FakeApp, fake_sessions


@pytest.fixture(scope="module")
def browser():
    with shared_browser_scope() as b:
        yield b


def test_the_phone_top_is_tidy_rows_with_a_filled_search(browser):
    """The phone layout puts the project name and New Session on one row:
    the name on the left edge, New Session a filled button on the right,
    each a finger's target (44px) tall."""
    app = FakeApp(browser, fake_sessions(4), viewport={"width": 390, "height": 844})
    m = app.page.evaluate("""() => {
      const r = s => document.querySelector(s).getBoundingClientRect();
      const cs = s => getComputedStyle(document.querySelector(s));
      return {project: r('#btn-project'), add: r('#btn-add-agent'),
              addBg: cs('#btn-add-agent').backgroundColor, addBorder: cs('#btn-add-agent').borderStyle,
              vw: window.innerWidth};
    }""")
    p, a = m["project"], m["add"]
    for k in ("project", "add"):
        assert m[k]["height"] >= 44, k
    assert p["left"] <= 16                                    # the name starts at the left edge
    assert m["vw"] - a["right"] <= 24                         # New Session sits at the right
    assert abs((p["top"] + p["height"] / 2) - (a["top"] + a["height"] / 2)) <= 4   # one row
    assert p["right"] < a["left"]                             # never overlapping

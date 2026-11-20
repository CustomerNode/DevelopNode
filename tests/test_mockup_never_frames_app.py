"""A mockup page never frames the whole app, and the Decide popup shows
another option of the same page without loading it again.

Framing the app boots it in every frame (blank frame, loading screen,
first-run prompts) and again on every choice the popup shows."""
import re
from pathlib import Path

import pytest

from engine import handoff_rules as hr

ROOT = Path(__file__).resolve().parents[1]


def _card(page):
    return {
        "type": "needs_you", "title": "Toolbar look", "headline": "Pick a toolbar look",
        "needs": {"kind": "decision", "ask": "Which toolbar look?",
                  "look": [{"label": "Options", "kind": "link", "url": "/static/scratch/" + page}],
                  "replies": [{"key": k, "label": "Look " + k, "reply": "Go " + k,
                               "screens": [{"label": k, "url": f"/static/scratch/{page}#v-{k.lower()}"}]}
                              for k in "AB"]},
    }


@pytest.fixture
def scratch(tmp_path, monkeypatch):
    monkeypatch.setattr(hr, "_SCRATCH_DIR", tmp_path)
    return tmp_path


@pytest.mark.parametrize("markup", [
    '<iframe src="/"></iframe>',
    '<iframe data-v="A" src="/?theme=dark"></iframe>',
    "<script>ifr.src = '/?theme=' + t;</script>",
    '<iframe src="http://127.0.0.1:5050/"></iframe>',
])
def test_a_page_that_frames_the_app_is_sent_back(scratch, markup):
    (scratch / "looks.html").write_text('<section data-option="now"></section>' + markup, encoding="utf-8")
    msg = hr.framed_app_problem(_card("looks.html"))
    assert msg and "frames the whole app" in msg


@pytest.mark.parametrize("markup", [
    '<header class="hdr"></header><div class="layout"></div>',
    '<iframe src="/static/scratch/other.html"></iframe>',
    '<iframe src="/api/preview/proxy?u=x"></iframe>',
])
def test_a_page_built_from_markup_passes(scratch, markup):
    (scratch / "looks.html").write_text('<section data-option="now"></section>' + markup, encoding="utf-8")
    assert hr.framed_app_problem(_card("looks.html")) is None


def test_one_shared_kept_copy_of_the_app_passes(scratch):
    """The variants pattern the instructions ask for: the app framed once, as
    <iframe data-keep> outside the option sections, each option applied inside it."""
    page = ('<iframe id="app" data-keep></iframe><section data-option="now"></section>'
            '<section data-option="A"></section><section data-option="B"></section>'
            "<script>app.src = location.origin + '/';</script>")
    (scratch / "looks.html").write_text(page, encoding="utf-8")
    assert hr.framed_app_problem(_card("looks.html")) is None


def test_a_kept_frame_inside_an_option_is_still_sent_back(scratch):
    page = ('<section data-option="now"></section>'
            '<section data-option="A"><iframe data-keep src="/"></iframe></section>')
    (scratch / "looks.html").write_text(page, encoding="utf-8")
    assert "frames the whole app" in (hr.framed_app_problem(_card("looks.html")) or "")


def test_the_rule_runs_in_the_card_review(scratch):
    (scratch / "looks.html").write_text('<iframe src="/"></iframe>', encoding="utf-8")
    assert any("frames the whole app" in p for p in hr.format_problems(_card("looks.html")))


_OPTS = '<section data-option="now"></section>' + ''.join(
    f'<section id="v-{k.lower()}" data-option="{k}"><style>{{css}}</style></section>' for k in "AB")


def test_options_styled_for_one_theme_only_are_sent_back(scratch):
    css = 'html[data-theme="dark"] #v-a header { background: #000; }'
    (scratch / "looks.html").write_text(_OPTS.replace("{css}", css), encoding="utf-8")
    msg = hr.framed_app_problem(_card("looks.html"))
    assert msg and "one theme only" in msg


def test_options_styled_for_both_themes_pass(scratch):
    css = ('html[data-theme="dark"] #v-a header { background: #000; } '
           'html[data-theme="light"] #v-a header { background: #fff; }')
    (scratch / "looks.html").write_text(_OPTS.replace("{css}", css), encoding="utf-8")
    assert hr.framed_app_problem(_card("looks.html")) is None


def test_the_app_shows_no_loading_screen_inside_a_frame():
    html = (ROOT / "src" / "web" / "templates" / "index.html").read_text(encoding="utf-8")
    assert re.search(r"window\.self\s*!==\s*window\.top\)\s*\{\s*el\.remove\(\)", html)


def test_switching_choices_on_one_page_reisolates_instead_of_reloading():
    js = (ROOT / "src" / "web" / "static" / "js" / "last-card.js").read_text(encoding="utf-8")
    body = js[js.index("function _switchInPlace("):js.index("function _explainHTML(")]
    assert "f._vnPage === page" in body and "f._vnShow()" in body
    assert "f._vnUndo" in js and "return () => undo.reverse()" in js


def test_the_app_can_show_a_look_for_one_page_without_saving_it():
    html = (ROOT / "src" / "web" / "templates" / "index.html").read_text(encoding="utf-8")
    assert "css/chrome-looks.css" in html and "js/chrome-look.js" in html
    js = (ROOT / "src" / "web" / "static" / "js" / "chrome-look.js").read_text(encoding="utf-8")
    assert "get('chrome')" in js and "setItem" not in js   # a preview never changes the saved look
    assert "vn:set-address:ok" in js and "e.origin !== location.origin" in js
    css = (ROOT / "src" / "web" / "static" / "css" / "chrome-looks.css").read_text(encoding="utf-8")
    for look in ("family", "text", "hairline", "lit"):
        assert f'html[data-chrome="{look}"]' in css and f'[data-chrome="{look}"]' in js.replace(look + ": 1", f'[data-chrome="{look}"]')
    assert '[data-theme="light"]' in css   # every look has its light values


def test_another_look_of_the_app_switches_in_place():
    js = (ROOT / "src" / "web" / "static" / "js" / "last-card.js").read_text(encoding="utf-8")
    body = js[js.index("function _switchInPlace("):js.index("function _explainHTML(")]
    assert "abs = new URL(next, location.href).href" in body and "_vnPage === page" in body

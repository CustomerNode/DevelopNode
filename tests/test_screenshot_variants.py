"""When the user's request came with a screenshot of a screen, the variants
are that real screen, changed: never an imitation of it redrawn by hand on a
scratch page (a fake phone, a stand-in header).  This holds for VibeNode's own
screens too.  Every page, message and card here is made up."""

import pytest

from engine import handoff_evidence as E
from engine import handoff_rules as R
from engine import smart_termination as S

SHOT = "make the share tray feel friendlier\nImage: /tmp/uploads/20990101-shot.png"

FAKE_PHONE = """<!doctype html><html><head><style>.phone{width:390px}.hdr{height:52px}</style></head><body>
<section id="now" data-option="now"><div class="phone"><div class="hdr">Inbox</div><ul class="tray"><li>Copy</li></ul></div></section>
<section id="a" data-option="A"><div class="phone"><div class="hdr">Inbox</div><div class="sheet">Copy</div></div></section>
<section id="b" data-option="B"><div class="phone"><div class="hdr">Inbox</div><div class="grid">Copy</div></div></section>
<section id="c" data-option="C"><div class="phone"><div class="hdr">Inbox</div><div class="tiles">Copy</div></div></section>
</body></html>"""

# Sections built by the page's own script: the keys are only in a list.
SCRIPTED_FAKE = """<!doctype html><html><head><style>[data-option="A"] .sheet{bottom:0}[data-option="B"] .grid{gap:8px}[data-option="C"] .tiles{gap:12px}</style></head><body>
<div id="wrap"></div><script>
['now','A','B','C'].forEach(function(k){var d=document.createElement('div');d.dataset.option=k;
d.innerHTML='<div class="phone"><div class="hdr">Inbox</div></div>';wrap.appendChild(d);});
</script></body></html>"""

FRAMED_REAL = """<!doctype html><html><body>
<section id="now" data-option="now"><iframe src="/"></iframe></section>
<section id="a" data-option="A"><iframe src="/?tray=sheet"></iframe></section>
<section id="b" data-option="B"><iframe src="/?tray=grid"></iframe></section>
<section id="c" data-option="C"><img src="/static/scratch/shot-tiles.png" alt=""></section>
</body></html>"""

SCRIPTED_FRAMED = """<!doctype html><html><body><div id="wrap"></div><script>
['now','A','B','C'].forEach(function(k){var f=document.createElement('iframe');f.dataset.option=k;
f.src='/?tray='+k;wrap.appendChild(f);});</script><style>[data-option="A"]{}[data-option="B"]{}[data-option="C"]{}</style></body></html>"""


@pytest.fixture
def scratch(tmp_path, monkeypatch):
    d = tmp_path / "scratch"
    d.mkdir()
    for name, html in (("tray-fake.html", FAKE_PHONE), ("tray-scripted.html", SCRIPTED_FAKE),
                       ("tray-framed.html", FRAMED_REAL), ("tray-scripted-framed.html", SCRIPTED_FRAMED)):
        (d / name).write_text(html)
    monkeypatch.setattr(R, "_SCRATCH_DIR", d)
    return d


def _decision(page, full=""):
    replies = [{"key": k, "label": label, "reply": label,
                "screens": [{"label": label, "url": f"/static/scratch/{page}#{k.lower()}", "device": "phone"}]}
               for k, label in (("A", "Sheet from the bottom"), ("B", "Grid of actions"), ("C", "Big tiles"))]
    card = {"type": "needs_you", "title": "Share tray", "headline": "Pick a style for the inbox share tray.",
            "needs": {"kind": "decision", "ask": "Which style should the share tray use?",
                      "look": [{"label": "Styles", "kind": "link", "url": f"/static/scratch/{page}"}],
                      "replies": replies}}
    if full:
        card["full_answer"] = full
    return card


def _facts(request=SHOT, cwd=""):
    return E.TurnFacts(requests=[request], last_user=request, cwd=cwd)


def test_a_redrawn_copy_of_the_screen_he_sent_is_sent_back(scratch):
    out = E.screenshot_variants_problems(_decision("tray-fake.html"), _facts())
    assert out and "screenshot" in out[0] and "real screen" in out[0]


def test_script_built_imitations_are_caught_too(scratch):
    assert E.screenshot_variants_problems(_decision("tray-scripted.html"), _facts())


def test_variants_framed_on_the_real_page_pass(scratch):
    assert E.screenshot_variants_problems(_decision("tray-framed.html"), _facts()) == []
    assert E.screenshot_variants_problems(_decision("tray-scripted-framed.html"), _facts()) == []


def test_no_screenshot_no_complaint(scratch):
    assert E.screenshot_variants_problems(_decision("tray-fake.html"),
                                          _facts("make the share tray feel friendlier")) == []


def test_a_picture_that_is_not_a_screen_can_say_so(scratch):
    card = _decision("tray-fake.html", full="## Why\nDrawn by hand because the picture is a sketch on paper.")
    assert E.screenshot_variants_problems(card, _facts()) == []


def test_only_decisions_are_judged(scratch):
    card = _decision("tray-fake.html")
    card["needs"]["kind"] = "none"
    assert E.screenshot_variants_problems(card, _facts()) == []


def test_it_runs_in_the_stop_for_vibenode_itself(scratch, tmp_path):
    home = tmp_path / "selfapp"
    (home / "src" / "engine").mkdir(parents=True)
    (home / "src" / "engine" / "handoff_rules.py").write_text("")
    out = E.problems(_decision("tray-fake.html"), _facts(cwd=str(home)))
    assert any("screenshot" in p for p in out)


def test_the_guidance_names_the_rule():
    assert "sends a screenshot of a screen" in S.INSTRUCTIONS

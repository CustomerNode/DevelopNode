"""An answer card ("explain") after the user gave an order and the turn changed
files is sent back: it draws no Validate row, so the work is hidden.  All
messages are made up."""

import pytest

from engine import handoff_evidence as E
from engine import handoff_rules as R


def _explain(**extra):
    card = {"type": "explain", "title": "Old banner", "headline": "The old banner no longer shows.",
            "answer": "It came from a stale setting; I removed it.", "full_answer": "## Changes\n- Removed it."}
    card.update(extra)
    return card


def _act(tool, detail):
    return E.Action(tool=tool, detail=detail, ok=True)


EDIT = _act("Edit", "file_path: /work/app/static/site.css\nreplace_all: False")
PY_WRITE = _act("Bash", "python3 - <<'EOF'\np='app/rules.py'; s=open(p).read()\nopen(p,'w').write(s)\nEOF")
SED = _act("Bash", "sed -i 's/old/new/' app/page.js")
RESTORE = _act("Bash", "git checkout -- app/page.js")


def _facts(said, *acts):
    return E.TurnFacts(last_user=said, turn_actions=list(acts))


@pytest.mark.parametrize("said", [
    "stop that and return to the footer task from before",
    "the footer lost its links, restore them",
    "yes, do that: give the panel the new colours",
    "the banner keeps showing up for no reason",
])
@pytest.mark.parametrize("act", [EDIT, PY_WRITE, SED, RESTORE])
def test_an_answer_card_after_an_order_and_changes_is_sent_back(said, act):
    out = E.answer_after_work_problems(_explain(), _facts(said, act))
    assert out and '"done"' in out[0] and "validate" in out[0]
    assert any("order, not a question" in p for p in E.problems(_explain(), _facts(said, act)))


@pytest.mark.parametrize("said", [
    "why does the banner show up?",
    "how does the sidebar decide its order",
    "the footer is fine now, so how is the banner chosen",
])
def test_a_question_may_end_on_an_answer_card(said):
    assert E.answer_after_work_problems(_explain(), _facts(said, EDIT)) == []


@pytest.mark.parametrize("act", [
    _act("Bash", "grep -n banner app/page.js"),
    _act("Read", "file_path: /work/app/page.js"),
    _act("Bash", "cd /tmp/shots && cat > shot.py <<'EOF'\nprint(1)\nEOF"),
    _act("Write", "file_path: /tmp/notes.txt"),
    _act("Bash", "cp /tmp/shot.png /work/app/static/scratch/banner.png"),
    _act("Bash", "python3 tool.py 2>&1 | tail -5 > /dev/null"),
])
def test_reading_or_scratch_work_is_not_a_change(act):
    assert E.answer_after_work_problems(_explain(), _facts("tell me about the banner", act)) == []


def test_other_card_types_and_redo_requests_pass():
    f = _facts("restore the footer links", EDIT)
    assert E.answer_after_work_problems(_explain(type="done"), f) == []
    redo = _facts("Flagged summary: your last Answer card was off (too long).", EDIT)
    assert E.answer_after_work_problems(_explain(), redo) == []


def test_a_failed_edit_or_unknown_history_passes():
    failed = E.Action(tool="Edit", detail="file_path: /work/a.css", ok=False)
    assert E.answer_after_work_problems(_explain(), _facts("fix the footer", failed)) == []
    assert E.answer_after_work_problems(_explain(), E.TurnFacts(last_user="fix the footer")) == []


def test_the_guide_says_an_order_with_changes_ends_on_done():
    assert "An \"explain\" card has no Validate row" in R.INSTRUCTIONS

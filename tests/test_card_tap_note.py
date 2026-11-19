"""A summary button's message carries a hidden note saying the user tapped it.

The words a button sends are the reply text the session wrote on its own card;
unmarked, the session read them as the user's own words.  The note is a
⟦VN-NOTE⟧ block, so every place that reads "the user's words" must drop it,
and every place that matches an answer against a card's replies must still
match.  The browser side is covered in tests/test_card_finding_band.py
(marked) and tests/test_card_approval_band.py / tests/test_card_redo.py
(left plain on purpose)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "src/web/static/js/last-card.js").read_text("utf-8")


def _note() -> str:
    m = re.search(r"const CARD_TAP_MARK = '([^']+)';", JS)
    assert m, "last-card.js defines CARD_TAP_MARK"
    return "⟦VN-NOTE⟧\n" + m.group(1) + " The user did not type the message below.\n⟦/VN-NOTE⟧"


def _tapped(words: str) -> str:
    return _note() + "\n\n" + words


def test_the_checker_reads_only_the_words():
    from engine.handoff_evidence import clean_request, answers_choice
    assert clean_request(_tapped("Fix it first")) == "Fix it first"
    card = {"type": "needs_you", "needs": {"kind": "decision", "replies": [
        {"key": "A", "label": "Fix it first", "reply": "Fix it first"},
        {"key": "B", "label": "Ship it anyway", "reply": "Ship it anyway"}]}}
    assert answers_choice(card, clean_request(_tapped("Ship it anyway")))


def test_code_pipeline_reads_only_the_words():
    from features.pipeline.decisions import clean_text
    assert clean_text(_tapped("Commit it anyway")) == "Commit it anyway"


def test_titles_and_tone_ignore_the_note():
    from shared.tone import upset_question, INJECTED
    assert INJECTED.sub("", _tapped("Ship it")).strip() == "Ship it"
    assert not upset_question(_tapped("Ship it"))


def test_the_chat_strips_the_note_from_bubbles_and_the_queue():
    lp = (ROOT / "src/web/static/js/live-panel.js").read_text("utf-8")
    assert "VN-(?:MOBILE|NOTE)" in lp
    body = lp.split("function _queueDisplayText", 1)[1].split("\n}", 1)[0]
    assert "_stripVnMeta" in body


def test_the_chat_knows_the_same_mark_and_draws_a_full_width_line():
    lp = (ROOT / "src/web/static/js/live-panel.js").read_text("utf-8")
    m = re.search(r"const _CARD_TAP_MARK = '([^']+)';", lp)
    j = re.search(r"const CARD_TAP_MARK = '([^']+)';", JS)
    assert m and j and m.group(1) == j.group(1), "the chat and the summary must share one mark"
    # both the server's entry and the instant bubble are labelled
    assert lp.count("_markCardTap(") >= 3
    css = (ROOT / "src/web/static/style.css").read_text("utf-8")
    rule = re.search(r"\.msg\.user\.vn-tap-msg \{([^}]*)\}", css)
    # the flex thread squashes a box with overflow hidden to 2px without flex: none
    assert rule and "flex: none" in rule.group(1)

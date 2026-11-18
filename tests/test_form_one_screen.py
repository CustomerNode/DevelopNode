"""A form question's popup screen has a word budget.

The Decide popup's form shows ONE question at a time: its question, its
context and every option's label, gain and verdict are read as one screen
before a single tap.  Per-field caps alone let a question carry about 110
words (a long background paragraph full of build details, then two options
each with three lines), a wall of text for one pick.  ``_form_question_faults``
(src/engine/handoff_rules.py) caps the context, each label, gain and verdict,
and the whole screen: ``form_screen_budget`` words, 60 with two options and
15 more per further option.
"""
import copy

from engine import handoff_check as hc
from engine import handoff_rules as hr
from engine import smart_termination as st


def _q(**over):
    # A question about how often a job runs, not how something looks: a
    # look question needs pictures (test_form_visual_options.py).
    q = {"id": "backup", "question": "Should the sample backup run every night?",
         "context": "Today the backup runs once a week, which some readers find far too rare.",
         "options": [{"key": "A", "label": "Run it nightly", "recommended": True,
                      "gain": "The backup never misses a day", "verdict": "Matches every other job already"},
                     {"key": "B", "label": "Keep it weekly", "gain": "The disk use stays the same",
                      "verdict": "Stale by the weekend for readers"}]}
    q.update(over)
    return q


def _card(form):
    return {"type": "needs_you", "title": "Sample backup choices", "headline": "Two sample questions",
            "context": "x", "needs": {"kind": "decision", "ask": "Answer the sample questions",
                                      "why": "They block the sample change", "form": form}}


def _second():
    return _q(id="size", question="Should the sample backup skip the weekends?")


def _problems(q):
    return " ".join(hr.split_problems(_card([q, _second()])))


def test_a_short_question_screen_passes():
    assert hr.form_screen_words(_q()) <= hr.form_screen_budget(2)
    assert hr.split_problems(_card([_q(), _second()])) == []


def test_a_wall_of_text_question_is_sent_back_naming_the_screen():
    # every part inside its own cap, the screen as a whole over budget
    wordy = _q(context=" ".join(["background"] * 28),
               options=[{"key": "A", "label": "Run it nightly on every machine", "recommended": True,
                         "gain": "The backup never misses a day for any reader at all",
                         "verdict": "Matches every other job already and costs nothing to keep"},
                        {"key": "B", "label": "Keep it on the weekly run", "gain": "The disk use stays the same everywhere it is kept",
                         "verdict": "Stale by the weekend for every reader who restores a file"}])
    assert hr.form_screen_words(wordy) > hr.form_screen_budget(2)
    says = _problems(wordy)
    assert "popup screen" in says and f"over {hr.form_screen_budget(2)}" in says


def test_more_options_earn_more_words():
    assert hr.form_screen_budget(3) == hr.form_screen_budget(2) + hr.FORM_SCREEN_PER_EXTRA_OPTION
    assert hr.form_screen_budget(2) == hr.FORM_SCREEN_WORDS


def test_a_long_background_paragraph_is_sent_back():
    says = _problems(_q(context=" ".join(["detail"] * (hr.FORM_CONTEXT_MAX_WORDS + 1))))
    assert f"at most {hr.FORM_CONTEXT_MAX_WORDS} words" in says and "Full" in says


def test_a_long_label_gain_or_verdict_is_sent_back():
    long_line = " ".join(["word"] * (hr.FORM_LINE_MAX_WORDS + 1))
    for field in ("gain", "verdict"):
        q = _q()
        q["options"][1][field] = long_line
        assert f"\"{field}\" is at most {hr.FORM_LINE_MAX_WORDS} words" in _problems(q)
    q = _q()
    q["options"][0]["label"] = " ".join(["word"] * (hr.FORM_LABEL_MAX_WORDS + 1))
    assert f"\"label\" is at most {hr.FORM_LABEL_MAX_WORDS} words" in _problems(q)


def test_a_four_word_gain_is_enough_in_a_form():
    q = _q()
    q["options"][1]["gain"] = "The disk use stays"
    assert hr.split_problems(_card([q, _second()])) == []
    q["options"][1]["gain"] = "Disk use stays"
    assert "\"gain\" needs at least" in _problems(q)


def test_sessions_are_told_the_budget_and_to_look_at_the_popup():
    text = st.INSTRUCTIONS
    assert f"at most {hr.FORM_SCREEN_WORDS} words with two options" in text
    assert "Open the popup and look at it" in text
    assert "never how it is built" in text


def test_the_blank_form_fits_its_own_budget():
    blank = copy.deepcopy(hr.SPLIT_TEMPLATES["form"]["example"])
    assert hr.form_screen_words(blank) <= hr.form_screen_budget(len(blank["options"]))
    form = hc.skeleton("form")["needs"]["form"]
    assert all(hr.form_screen_words(q) <= hr.form_screen_budget(len(q["options"])) for q in form)

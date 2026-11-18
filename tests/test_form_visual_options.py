"""A form whose questions are about how something looks shows each option.

The form popup (needs.form) shows one question at a time with its options
as cards.  A page in needs.look or a screenshot link stays on the summary
behind the popup, so a question like "outline or solid icons in the
toolbar?" was answered from labels alone.  form_visual_problem in
engine/handoff_rules.py sends such a form back unless every option of each
question about looks carries an "image".
"""

from engine import handoff_rules as hr
from engine import smart_termination as st


def _opt(key, label, rec=False, image=None):
    o = {"key": key, "label": label, "gain": f"what picking {key} gets you here",
         "verdict": f"the reason {key} is or is not the pick", "recommended": rec}
    if image:
        o["image"] = image
    return o


def _q(qid, question, context, labels, images=False):
    return {"id": qid, "question": question, "context": context,
            "options": [_opt(chr(65 + i), lab, i == 0,
                             f"/static/scratch/{qid}-{i}.png" if images else None)
                        for i, lab in enumerate(labels)]}


def _card(qs, title="Garden planner choices", headline="Pick how the planner works"):
    return {"type": "needs_you", "title": title, "headline": headline,
            "needs": {"kind": "decision", "ask": "Pick for each part of the planner",
                      "why": "Each pick changes what people see.",
                      "look": [{"label": "Both ways side by side", "kind": "link",
                                "url": "/static/scratch/planner-looks.html"}],
                      "form": qs}}


def _visual(problems):
    return [p for p in problems if "offers its options as words only" in p]


LOOKS = _q("bar", "Which icon style for the planner toolbar?",
           "The small controls along the top of the seed planner.",
           ["Thin outline icons everywhere", "Solid filled icons everywhere"])
STORE = _q("store", "Where should seed lists be kept?",
           "Decides whether lists follow people between their devices.",
           ["Keep them on this device", "Keep them in the shared store"])


def test_a_form_about_looks_with_words_only_is_sent_back_even_with_a_page_to_look_at():
    out = _visual(hr.split_problems(_card([LOOKS, dict(LOOKS, id="menu")])))
    assert len(out) == 1 and "question 1, 2" in out[0]


def test_every_option_pictured_passes():
    looks = _q("bar", LOOKS["question"], LOOKS["context"],
               [o["label"] for o in LOOKS["options"]], images=True)
    assert not _visual(hr.split_problems(_card([looks, dict(looks, id="menu")])))


def test_one_option_without_a_picture_still_fails():
    looks = _q("bar", LOOKS["question"], LOOKS["context"],
               [o["label"] for o in LOOKS["options"]], images=True)
    del looks["options"][1]["image"]
    assert _visual(hr.split_problems(_card([looks, STORE])))


def test_a_form_with_nothing_visual_needs_no_pictures():
    other = _q("sync", "How often should lists sync?",
               "Sets how fresh a list is on a second device.",
               ["Sync every minute", "Sync only when opened"])
    assert not _visual(hr.split_problems(_card([STORE, other])))


def test_doing_a_job_on_someones_screen_is_not_a_question_about_looks():
    when = _q("when", "When can I tidy the inbox on his screen?",
              "The cleanup needs his computer for about ten minutes.",
              ["This evening after dinner", "Saturday morning before lunch"])
    assert not _visual(hr.split_problems(_card([STORE, when])))


def test_only_the_question_about_looks_needs_pictures():
    out = _visual(hr.split_problems(_card([STORE, LOOKS])))
    assert len(out) == 1 and "question 2 " in out[0]


def test_a_form_named_as_a_look_on_its_title_needs_pictures_on_every_question():
    plain1 = _q("p1", "Which one for the seed list rows?", "The rows people scroll most often.",
                ["The first variant shown", "The second variant shown"])
    plain2 = dict(plain1, id="p2")
    out = _visual(hr.split_problems(_card([plain1, plain2], title="Planner icon looks")))
    assert out and "question 1, 2" in out[0]


def test_the_option_pictures_are_link_checked():
    looks = _q("bar", LOOKS["question"], LOOKS["context"],
               [o["label"] for o in LOOKS["options"]], images=True)
    urls = dict(hr._card_urls(_card([looks, STORE])))
    assert urls["needs.form[0].options[0].image"] == "/static/scratch/bar-0.png"


def test_sessions_are_told_a_form_about_looks_pictures_each_option():
    text = " ".join(st.INSTRUCTIONS.split())
    assert "No needs.look or screens needed" not in text
    assert "popup hides needs.look" in text
    assert "carries its own \"image\"" in text

"""A Done card's Try it row opens inside the app's own review window.

The card frames a Validate page itself only for addresses of this app, this
machine and the tailnet (``_reviewSrc`` in last-card.js); any other web
address opens in a separate browser tab.  A public site that lets itself be
framed must be shown through a scratch page that frames it; one that refuses
framing passes, since no window of the app could show it.
"""
import pytest

from engine import handoff_rules as hr

DONE = {
    "type": "done",
    "title": "Pricing page", "path": ["Example shop"],
    "headline": "The example shop's pricing page now lists the yearly plan first.",
    "verified": [{"check": "Live page", "result": "Yearly plan is first", "ok": True}],
    "links": [{"label": "After: yearly first", "kind": "image", "url": "/static/scratch/x.png"}],
    "validate": {"how": "Open the pricing page; yearly is first.", "url": "https://shop.example.org/pricing"},
    "needs": {"kind": "none", "why": "Done and live.", "next": "Name the next change."},
}


def _card(url):
    return dict(DONE, validate={"how": "Open the pricing page; yearly is first.", "url": url})


def test_a_frameable_public_site_is_sent_back():
    reason = hr.outside_app_validate_problem(_card("https://shop.example.org/pricing"), probe=lambda u: True)
    assert reason and "separate browser tab" in reason and "iframe" in reason


def test_format_problems_runs_it(monkeypatch):
    monkeypatch.setattr(hr, "frames_allowed", lambda u: True)
    assert any("separate browser tab" in p for p in hr.format_problems(_card("https://shop.example.org/")))


@pytest.mark.parametrize("answer", [False, None])
def test_a_site_that_refuses_framing_or_cannot_be_reached_passes(answer):
    assert hr.outside_app_validate_problem(_card("https://code.example.net/x"), probe=lambda u: answer) is None


@pytest.mark.parametrize("url", ["/static/scratch/shop-live.html", "/static/scratch/shop-live.html#pricing",
                                 "http://localhost:8000/pricing", "http://127.0.0.1:3000/",
                                 "https://my-pc.tail0000.ts.net:8796/pricing",
                                 "https://shop.example.org/shot.png", "https://shop.example.org/site.zip"])
def test_pages_the_app_can_show_or_other_rules_own_pass(url):
    called = []
    assert hr.outside_app_validate_problem(_card(url), probe=lambda u: called.append(u) or True) is None
    assert not called


def test_the_probe_reads_the_frame_headers(monkeypatch):
    import urllib.request

    class _Resp:
        status = 200

        def __init__(self, headers):
            from email.message import Message
            self.headers = Message()
            for k, v in headers.items():
                self.headers[k] = v

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.delenv("VIBENODE_LINK_CHECK", raising=False)
    cases = {
        "open.example.org": ({}, True),
        "deny.example.org": ({"X-Frame-Options": "DENY"}, False),
        "self.example.org": ({"Content-Security-Policy": "default-src 'self'; frame-ancestors 'self'"}, False),
        "star.example.org": ({"Content-Security-Policy": "frame-ancestors *"}, True),
    }
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda req, timeout=0: _Resp(cases[req.full_url.split("/")[2]][0]))
    hr._frame_cache.clear()
    for host, (_, want) in cases.items():
        assert hr.frames_allowed(f"https://{host}/") is want, host
    hr._frame_cache.clear()


def test_the_suite_switch_skips_the_network(monkeypatch):
    monkeypatch.setenv("VIBENODE_LINK_CHECK", "0")
    assert hr.frames_allowed("https://shop.example.org/") is None


def test_the_guidance_names_the_framing_page():
    assert "opens in a separate browser tab, outside the app's review window" in hr.INSTRUCTIONS

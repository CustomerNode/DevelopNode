"""The public website that may ask this computer's VibeNode whether it is up.

developnode.com/app opens VibeNode when it is running, offers Start when the
Start helper (the reviver) answers, and offers the install prompt otherwise.
To tell those apart its page reads VibeNode's ping from the person's own
browser, which the browser allows only when VibeNode names the site in
``Access-Control-Allow-Origin``.

Exposed to these origins, and nothing else: the ping (``{"ok": true}``, no
data) and, on the Start helper, its Start action. Never sessions, files or
commands. The reviver (stdlib only, it must run when VibeNode's packages are
broken) keeps its own copy of the list; a test holds the two equal.
"""
from __future__ import annotations

SITE_ORIGINS = frozenset({"https://developnode.com", "https://www.developnode.com"})


def site_cors_headers(origin: str | None) -> dict[str, str]:
    """Headers that let ``origin`` read the response, or {} for any other."""
    if not origin or origin not in SITE_ORIGINS:
        return {}
    return {
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
        # Chrome's older Private Network Access preflight asks for this when a
        # public page reaches a loopback address.
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Allow-Methods": "GET, POST",
    }

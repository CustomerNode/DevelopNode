"""Org calls share one TLS context instead of building one per call.

Building a context loads the whole CA bundle; Phone a Friend's poll calls
``rpc`` every few seconds, so a context per call kept the web server busy.
"""
import ssl

import httpx

from web.orgs import store


class _Resp:
    status_code = 200
    text = "null"

    def json(self):
        return None


def test_every_call_reuses_one_verifying_context(monkeypatch):
    seen = []
    monkeypatch.setattr(httpx, "post", lambda url, **k: (seen.append(k.get("verify")), _Resp())[1])
    for _ in range(3):
        store.rpc("pf_sync", {}, url="https://example-proj.supabase.co", key="k")
    assert len(seen) == 3
    assert isinstance(seen[0], ssl.SSLContext)
    assert seen[0] is seen[1] is seen[2]
    assert seen[0].verify_mode == ssl.CERT_REQUIRED and seen[0].check_hostname

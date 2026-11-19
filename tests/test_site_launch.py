"""developnode.com/app: the website that opens, starts or installs VibeNode.

The page reads VibeNode's ping from the person's browser. These tests hold
the three pieces VibeNode provides for it:

- the web server's ping names the site (and only the site) in its CORS
  headers, and answers the preflight;
- the Start helper (reviver) names the same site on its 503 ping and on
  Start, from the same list;
- the developnode:// link starts VibeNode with ``--background`` and never
  hands the link's text to it.
"""
import io
import sys
from email.message import Message
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from shared.site_origins import SITE_ORIGINS, site_cors_headers  # noqa: E402

SITE = "https://developnode.com"


@pytest.fixture()
def client():
    from web import create_app
    app = create_app(testing=True)
    app.config["TESTING"] = True
    return app.test_client()


def test_ping_names_the_site(client):
    r = client.get("/api/ping", headers={"Origin": SITE})
    assert r.status_code == 200 and r.get_json() == {"ok": True}
    assert r.headers["Access-Control-Allow-Origin"] == SITE
    assert r.headers["Access-Control-Allow-Private-Network"] == "true"


def test_ping_names_no_other_site(client):
    for origin in ("https://evil.example", "https://developnode.com.evil.example",
                   "http://developnode.com", None):
        headers = {"Origin": origin} if origin else {}
        r = client.get("/api/ping", headers=headers)
        assert r.status_code == 200
        assert "Access-Control-Allow-Origin" not in r.headers


def test_ping_answers_the_preflight(client):
    r = client.options("/api/ping", headers={
        "Origin": SITE, "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true"})
    assert r.status_code == 204
    assert r.headers["Access-Control-Allow-Origin"] == SITE


def test_cors_helper_is_exact():
    assert site_cors_headers("https://www.developnode.com")["Access-Control-Allow-Origin"] \
        == "https://www.developnode.com"
    assert site_cors_headers("https://developnode.co") == {}
    assert site_cors_headers("") == {}


# ── the Start helper ─────────────────────────────────────────────────────

def _reviver():
    import importlib.util
    spec = importlib.util.spec_from_file_location("_reviver_for_site_test",
                                                  ROOT / "src/launcher/reviver.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_reviver_uses_the_same_site_list():
    assert _reviver()._SITE_ORIGINS == SITE_ORIGINS


class _Fake:
    """Drive the reviver's request handler without a socket."""

    def __init__(self, handler_cls, method, path, origin):
        h = handler_cls.__new__(handler_cls)
        h.wfile = io.BytesIO()
        h.request_version = "HTTP/1.1"
        h.requestline = f"{method} {path} HTTP/1.1"
        h.command = method
        h.path = path
        msg = Message()
        if origin:
            msg["Origin"] = origin
        h.headers = msg
        h.server = type("S", (), {"reviver": None})()
        h.client_address = ("127.0.0.1", 0)
        getattr(h, "do_" + method)()
        self.raw = h.wfile.getvalue().decode("latin-1")


def test_reviver_ping_and_start_name_the_site(monkeypatch):
    rev = _reviver()
    monkeypatch.setattr(rev, "_device_name", lambda: "test-device")
    ping = _Fake(rev._ServeHandler, "GET", "/api/ping", SITE).raw
    assert " 503 " in ping.splitlines()[0]
    assert f"Access-Control-Allow-Origin: {SITE}" in ping
    start = _Fake(rev._ServeHandler, "POST", "/start", SITE).raw
    assert f"Access-Control-Allow-Origin: {SITE}" in start
    pre = _Fake(rev._ServeHandler, "OPTIONS", "/start", SITE).raw
    assert " 204 " in pre.splitlines()[0] and "Access-Control-Allow-Private-Network: true" in pre
    other = _Fake(rev._ServeHandler, "GET", "/api/ping", "https://evil.example").raw
    assert "Access-Control-Allow-Origin" not in other


# ── the developnode:// link ──────────────────────────────────────────────

def test_link_goes_to_the_exact_matcher():
    from launcher import url_scheme
    text = url_scheme._desktop_text()
    assert "MimeType=x-scheme-handler/developnode;" in text
    exec_line = next(l for l in text.splitlines() if l.startswith("Exec="))
    assert exec_line.endswith('url_scheme.py" handle %u')
    assert url_scheme._windows_command().endswith('url_scheme.py" handle "%1"')


@pytest.mark.parametrize("link,window", [
    ("developnode://open", True), ("developnode://open/", True), ("DEVELOPNODE://OPEN", True),
    ("developnode://start", False), ("developnode://open?x=1", False),
    ("developnode://open/../x", False), ("", False), ("--background", False),
])
def test_only_exactly_open_opens_a_window(link, window):
    from launcher import url_scheme
    cmd = url_scheme.launch_command(link)
    assert cmd[1].endswith("session_manager.py")
    assert cmd[2:] == ([] if window else ["--background"])


def test_link_registration_is_idempotent(tmp_path, monkeypatch):
    if not sys.platform.startswith("linux"):
        pytest.skip("desktop entries are the Linux registration")
    from launcher import url_scheme
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    calls = []
    monkeypatch.setattr(url_scheme.subprocess, "run", lambda *a, **k: calls.append(a))
    assert not url_scheme.status()
    url_scheme.ensure()
    assert url_scheme.status()
    n = len(calls)
    url_scheme.ensure()                  # already registered: nothing runs again
    assert len(calls) == n
    url_scheme.remove()
    assert not url_scheme.status()


def test_windows_registration_writes_the_per_user_link(monkeypatch):
    """The Windows branch, against a stand-in registry (never the real one)."""
    import types
    reg = {}

    class Key:
        def __init__(self, path): self.path = path
        def __enter__(self): return self
        def __exit__(self, *a): return False

    fake = types.SimpleNamespace(
        HKEY_CURRENT_USER="HKCU", REG_SZ=1,
        CreateKey=lambda root, path: (reg.setdefault(path, {}), Key(path))[1],
        OpenKey=lambda root, path: Key(path) if path in reg else (_ for _ in ()).throw(OSError(path)),
        SetValueEx=lambda k, name, _r, _t, value: reg[k.path].__setitem__(name, value),
        QueryValueEx=lambda k, name: (reg[k.path][name], 1),
        DeleteKey=lambda root, path: reg.pop(path) if path in reg else (_ for _ in ()).throw(OSError(path)),
    )
    monkeypatch.setitem(sys.modules, "winreg", fake)
    from launcher import url_scheme
    monkeypatch.setattr(url_scheme.sys, "platform", "win32")
    assert not url_scheme.status()
    url_scheme.ensure()
    base = r"Software\Classes\developnode"
    assert reg[base] == {"": "URL:DevelopNode", "URL Protocol": ""}
    cmd = reg[base + r"\shell\open\command"][""]
    assert cmd.endswith('url_scheme.py" handle "%1"')
    assert url_scheme.status()
    url_scheme.remove()
    assert base not in reg and not url_scheme.status()

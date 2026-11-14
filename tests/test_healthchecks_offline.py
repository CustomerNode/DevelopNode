"""The "No Internet Connection" overlay fires on the computer with the network down.

A page opened from this machine reaches its own server with no network, so a
working /api/ping must not count as proof of internet there. Over Mobile
Command (a .ts.net page) it still does. Runs the real healthchecks.js in Node
with a fake browser.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "src" / "web" / "static" / "js" / "healthchecks.js"

HARNESS = r"""
const fs = require('fs'), vm = require('vm');
const [src, host, internetUp] = [fs.readFileSync(process.argv[2], 'utf8'), process.argv[3], process.argv[4] === '1'];
const overlay = { classList: { s: new Set(), add(c){this.s.add(c)}, remove(c){this.s.delete(c)} },
  querySelector(){ return { innerHTML:'', textContent:'', style:{} }; } };
const ctx = {
  location: { hostname: host }, navigator: { onLine: internetUp },
  document: { getElementById: id => id === 'health-blocker' ? overlay : null, addEventListener(){}, visibilityState:'visible' },
  window: { addEventListener(){}, location: { reload(){} } },
  setInterval(){ return 1 }, clearInterval(){}, setTimeout(){ return 1 },
  AbortSignal: {},
  fetch(url) {
    if (url.startsWith('/api/ping')) return Promise.resolve({ ok: true, status: 200 });
    if (url.startsWith('/api/health')) return Promise.resolve({ ok: true, status: 200, json: () => ({ daemon: true }) });
    if (url.startsWith('/api/auth-status')) return Promise.resolve({ json: () => ({ loggedIn: true }) });
    return internetUp ? Promise.resolve({}) : Promise.reject(new TypeError('Failed to fetch'));
  },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
setTimeout(() => {
  vm.runInContext('_runHealthChecks()', ctx);
  console.log(JSON.stringify({ shown: overlay.classList.s.has('show'), fail: vm.runInContext('_currentFailId', ctx) }));
}, 50);
"""


def _run(tmp_path, host, internet_up):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    h = tmp_path / "harness.js"
    h.write_text(HARNESS, encoding="utf-8")
    out = subprocess.run([node, str(h), str(JS), host, "1" if internet_up else "0"],
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
def test_no_network_on_the_computer_shows_the_overlay(tmp_path, host):
    r = _run(tmp_path, host, internet_up=False)
    assert r == {"shown": True, "fail": "wifi"}


def test_network_up_on_the_computer_shows_nothing(tmp_path):
    assert _run(tmp_path, "localhost", internet_up=True)["shown"] is False


def test_phone_over_mobile_command_trusts_its_server(tmp_path):
    # A phone that reaches the server over the tailnet has a network, even if
    # the outside probe is blocked or slow during a handoff.
    assert _run(tmp_path, "pc.example.ts.net", internet_up=False)["shown"] is False

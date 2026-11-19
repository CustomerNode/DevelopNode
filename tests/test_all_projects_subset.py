"""All projects covers only the projects ticked in the picker's Choose list.

Runs the real all-projects.js in node with a fake localStorage and project list.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "src" / "web" / "static" / "js" / "all-projects.js"

HARNESS = r"""
const fs = require('fs');
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.window = { addEventListener() {} };
global._allProjects = [
  { encoded: 'C--code-Alpha', display: 'C:/code/Alpha', session_count: 3 },
  { encoded: 'C--code-Beta', display: 'C:/code/Beta', session_count: 5 },
  { encoded: 'C--code-Gamma', display: 'C:/code/Gamma', session_count: 7 },
];
eval(fs.readFileSync(process.argv[1], 'utf8'));
const A = window.VNAllProjects;
const out = {};
out.start = { shown: A.shown().length, label: A.label(), narrowed: A.narrowed() };
out.offBeta = A.setIncluded('C--code-Beta', false);
out.afterOff = { shown: A.shown().map(p => p.encoded), label: A.label(), narrowed: A.narrowed(),
  betaIn: A.included('C--code-Beta'), betaCwd: A.includesCwd('C:\\code\\Beta'),
  alphaCwd: A.includesCwd('C:/code/Alpha'), unknownCwd: A.includesCwd('C:/elsewhere') };
out.offGamma = A.setIncluded('C--code-Gamma', false);
out.offLast = A.setIncluded('C--code-Alpha', false);
out.afterLast = A.shown().map(p => p.encoded);
_allProjects.push({ encoded: 'C--code-Delta', display: 'C:/code/Delta', session_count: 1 });
out.newIsIn = A.included('C--code-Delta');
A.setIncluded('C--code-Beta', true); A.setIncluded('C--code-Gamma', true); A.setIncluded('C--code-Delta', true);
out.back = { label: A.label(), stored: localStorage.getItem('vnAllProjectsOff') };
console.log(JSON.stringify(out));
"""


def test_the_choose_list_narrows_all_projects():
    if shutil.which("node") is None:
        pytest.skip("node not installed")
    r = subprocess.run(["node", "-e", HARNESS, str(JS)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["start"] == {"shown": 3, "label": "All projects", "narrowed": False}
    assert out["offBeta"] is True
    a = out["afterOff"]
    assert a["shown"] == ["C--code-Alpha", "C--code-Gamma"]
    assert a["label"] == "2 of 3 projects" and a["narrowed"] is True
    assert a["betaIn"] is False and a["betaCwd"] is False
    assert a["alphaCwd"] is True and a["unknownCwd"] is True
    # At least one project always stays in.
    assert out["offGamma"] is True and out["offLast"] is False
    assert out["afterLast"] == ["C--code-Alpha"]
    # A project added later is in by default.
    assert out["newIsIn"] is True
    # Ticking everything back clears the stored list.
    assert out["back"] == {"label": "All projects", "stored": None}

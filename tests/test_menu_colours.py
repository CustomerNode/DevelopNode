"""Every menu and pop-up window takes one colour scheme (static/css/menus.css).

The layer must load after every other stylesheet, or an older per-menu colour wins again; and it must never
mark a row, heading or selection with the accent colour.
"""
import re
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "src" / "web"
CSS = WEB / "static" / "css" / "menus.css"


def test_the_menu_colours_load_after_every_other_stylesheet():
    html = (WEB / "templates" / "index.html").read_text(encoding="utf-8")
    sheets = re.findall(r"versioned_static\('([^']+\.css)'\)", html)
    assert sheets[-1] == "css/menus.css", sheets[-3:]


def test_the_menu_colours_use_the_popup_tokens_and_no_accent():
    css = CSS.read_text(encoding="utf-8")
    rules = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    assert "var(--pm-surface)" in rules and "var(--pm-line)" in rules and "var(--pm-scrim)" in rules
    assert "--accent" not in rules
    assert not re.search(r"124,\s*124,\s*255|85,\s*85,\s*204|99,\s*102,\s*241", rules)
    # a private name: the shared --bt is set per component elsewhere and must not change app-wide
    assert not re.search(r"--bt\s*:", rules)

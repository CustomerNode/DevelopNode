"""The developnode:// link: lets a web page start VibeNode on this computer.

developnode.com/app sends a person to one of two links:

- ``developnode://start``: VibeNode is installed but not running and the page
  is waiting for it to answer. The start file runs with ``--background`` (no
  splash, no window); the page takes the person in itself.
- ``developnode://open``: the browser will not let the page look at this
  computer (its local network setting is on Block), so the page cannot take
  anyone in. The start file runs as from the desktop shortcut: it starts
  VibeNode if needed and opens its window either way.

The link is matched exactly against those two; anything else is ``start``.
Nothing else in it is read, so a page can only ask to start or open VibeNode.
A running VibeNode is reused, never restarted (``_reuse_running_instance``).

Registration is per user (no administrator rights), idempotent, and done on
every VibeNode start (``ensure``), so an existing install gets it on its next
start. Windows: ``HKCU\\Software\\Classes\\developnode``. Linux: a desktop entry
with ``x-scheme-handler/developnode``. macOS needs an application bundle to
receive a link, so there the site falls back to its Start page and install
prompt.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCHEME = "developnode"
ROOT = Path(__file__).resolve().parents[2]          # the repo root
_LAUNCHER = ROOT / "session_manager.py"             # the start file that never moves
_DESKTOP_NAME = "developnode-url-handler.desktop"


def _python() -> Path:
    py = Path(sys.executable)
    if sys.platform == "win32":
        pyw = py.with_name("pythonw.exe")
        if pyw.exists():
            return pyw
    return py


_HANDLER = Path(__file__).resolve()


def _windows_command() -> str:
    # The link goes to this file's ``handle``, which only matches it exactly.
    return f'"{_python()}" "{_HANDLER}" handle "%1"'


def _desktop_path() -> Path:
    import os
    base = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    return base / "applications" / _DESKTOP_NAME


def _desktop_text() -> str:
    # The link goes to this file's ``handle``, which only matches it exactly.
    # Exec quotes per the desktop entry spec so a folder with spaces works.
    return ("[Desktop Entry]\n"
            "Type=Application\n"
            "Name=DevelopNode\n"
            f'Exec="{_python()}" "{_HANDLER}" handle %u\n'
            f"Path={ROOT}\n"
            "NoDisplay=true\n"
            "Terminal=false\n"
            f"MimeType=x-scheme-handler/{SCHEME};\n")


def _install_windows() -> bool:
    import winreg  # type: ignore[import-not-found]
    key_path = rf"Software\Classes\{SCHEME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:DevelopNode")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path + r"\shell\open\command") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, _windows_command())
    return True


def _status_windows() -> bool:
    import winreg  # type: ignore[import-not-found]
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            rf"Software\Classes\{SCHEME}\shell\open\command") as k:
            return winreg.QueryValueEx(k, "")[0] == _windows_command()
    except OSError:
        return False


def _remove_windows() -> None:
    import winreg  # type: ignore[import-not-found]
    for sub in (r"\shell\open\command", r"\shell\open", r"\shell", ""):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{SCHEME}{sub}")
        except OSError:
            pass


def _install_linux() -> bool:
    entry = _desktop_path()
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text(_desktop_text(), encoding="utf-8")
    try:
        subprocess.run(["xdg-mime", "default", _DESKTOP_NAME, f"x-scheme-handler/{SCHEME}"],
                       capture_output=True, timeout=10, check=False)
        subprocess.run(["update-desktop-database", str(entry.parent)],
                       capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        pass  # the entry alone is enough for most desktops
    return True


def status() -> bool:
    """True when this computer opens developnode:// links with this copy."""
    if sys.platform == "win32":
        return _status_windows()
    if sys.platform.startswith("linux"):
        p = _desktop_path()
        return p.exists() and p.read_text(encoding="utf-8") == _desktop_text()
    return False


def install() -> bool:
    """Register the link for this user. False where it is not supported."""
    if sys.platform == "win32":
        return _install_windows()
    if sys.platform.startswith("linux"):
        return _install_linux()
    return False


def remove() -> None:
    if sys.platform == "win32":
        _remove_windows()
    elif sys.platform.startswith("linux"):
        _desktop_path().unlink(missing_ok=True)


def ensure() -> None:
    """Called on every start: register when missing or pointing elsewhere.
    Never raises: a failure here must not stop VibeNode from starting."""
    try:
        if not status():
            install()
    except Exception:
        pass


def wants_window(link: str) -> bool:
    """True only for exactly developnode://open (a trailing slash allowed)."""
    return (link or "").strip().lower().rstrip("/") == f"{SCHEME}://open"


def launch_command(link: str) -> list[str]:
    cmd = [str(_python()), str(_LAUNCHER)]
    return cmd if wants_window(link) else cmd + ["--background"]


def handle(link: str) -> None:
    """What the operating system runs for a developnode:// link."""
    kw = {"cwd": str(ROOT), "stdin": subprocess.DEVNULL,
          "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if sys.platform == "win32":
        kw["creationflags"] = 0x00000200 | 0x08000000   # new process group, no window
    else:
        kw["start_new_session"] = True
    subprocess.Popen(launch_command(link), **kw)


if __name__ == "__main__":
    action = (sys.argv[1:] or ["status"])[0]
    if action == "handle":
        handle(sys.argv[2] if len(sys.argv) > 2 else "")
    elif action == "install":
        print("installed" if install() else "not supported on this system")
    elif action == "remove":
        remove()
        print("removed")
    else:
        print("installed" if status() else "not installed")

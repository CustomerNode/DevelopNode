"""On a session's PYTHONPATH (engine/runq session_env): Python imports this at
start-up, so every pytest run a session starts goes through the resource
queue, in any project and any virtualenv, with nothing installed into it.

A project or environment with its own sitecustomize keeps it: that one is
found further down sys.path and run after this.
"""
import os as _os
import sys as _sys

_HERE = _os.path.dirname(_os.path.abspath(__file__))


def _chain():
    """Run the sitecustomize this one shadows, if there is one."""
    import importlib.util
    for entry in _sys.path:
        try:
            if not entry or _os.path.abspath(entry) == _HERE:
                continue
        except (TypeError, ValueError):
            continue
        path = _os.path.join(entry, "sitecustomize.py")
        if _os.path.isfile(path):
            spec = importlib.util.spec_from_file_location("_shadowed_sitecustomize", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return


try:
    _parent = _os.path.dirname(_HERE)
    if _parent not in _sys.path:
        _sys.path.append(_parent)
    import runq_boot  # noqa: F401  (queues a pytest run; returns at once otherwise)
except SystemExit:
    raise
except Exception:
    pass

try:
    _chain()
except Exception:
    pass

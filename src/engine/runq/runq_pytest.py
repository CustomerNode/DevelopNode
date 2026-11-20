"""pytest plugin (via PYTEST_PLUGINS, set by runq_boot): records the run's
exit status so runq knows whether the run may be replayed."""
import os

import runq_boot

# pytest has read PYTEST_PLUGINS by the time it imports this, so take the name
# back out: a pytest this run starts (a suite testing a test runner) inherits
# the environment but not this process's sys.path, and would fail to import it.
_rest = [p for p in os.environ.get("PYTEST_PLUGINS", "").split(",") if p and p.strip() != "runq_pytest"]
if _rest:
    os.environ["PYTEST_PLUGINS"] = ",".join(_rest)
else:
    os.environ.pop("PYTEST_PLUGINS", None)


def pytest_sessionfinish(session, exitstatus):
    if not hasattr(session.config, "workerinput"):
        runq_boot.EXIT["code"] = int(exitstatus)

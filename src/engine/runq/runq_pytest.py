"""pytest plugin (via PYTEST_PLUGINS, set by runq_boot): records the run's
exit status so runq knows whether the run may be replayed."""
import runq_boot


def pytest_sessionfinish(session, exitstatus):
    if not hasattr(session.config, "workerinput"):
        runq_boot.EXIT["code"] = int(exitstatus)

import os
import subprocess
import sys
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def log_directory(tmp_path):
    environment = os.environ.copy()
    environment["SHELL_APP_LOG_DIR"] = str(tmp_path)
    script = """
from app.core.logging import logger

logger.debug("debug-event")
logger.info("info-event")
logger.warning("warning-event")
logger.error("error-event")
logger.critical("critical-event")
"""
    subprocess.run(
        [sys.executable, "-c", script],
        cwd=PROJECT_ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    return tmp_path


def test_creates_all_log_files(log_directory):
    assert {path.name for path in log_directory.iterdir()} == {
        "debug.log",
        "error.log",
        "warning.log",
    }


def test_debug_log_contains_every_level(log_directory):
    contents = (log_directory / "debug.log").read_text()

    for message in (
        "debug-event",
        "info-event",
        "warning-event",
        "error-event",
        "critical-event",
    ):
        assert message in contents


def test_warning_log_contains_only_warnings(log_directory):
    contents = (log_directory / "warning.log").read_text()

    assert "warning-event" in contents
    for message in ("debug-event", "info-event", "error-event", "critical-event"):
        assert message not in contents


def test_error_log_contains_errors_and_critical(log_directory):
    contents = (log_directory / "error.log").read_text()

    assert "error-event" in contents
    assert "critical-event" in contents
    for message in ("debug-event", "info-event", "warning-event"):
        assert message not in contents


def test_default_log_directory_uses_user_state_directory(tmp_path):
    environment = os.environ.copy()
    environment.pop("SHELL_APP_LOG_DIR", None)
    environment["XDG_STATE_HOME"] = str(tmp_path)
    script = """
from app.core.logging import logger

logger.info("default-log-directory")
"""
    subprocess.run(
        [sys.executable, "-c", script],
        cwd=PROJECT_ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )

    assert (tmp_path / "shell_app" / "log" / "debug.log").exists()
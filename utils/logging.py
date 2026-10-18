import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path


STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
LOG_DIR = Path(
    os.environ.get("SHELL_APP_LOG_DIR", STATE_DIR / "shell_app" / "log")
)


class ExactLevelFilter(logging.Filter):
    def __init__(self, level):
        super().__init__()
        self.level = level

    def filter(self, record):
        return record.levelno == self.level


def configure_logging():
    logger = logging.getLogger("shell_app")
    if logger.handlers:
        return logger

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    handlers = (
        ("debug.log", logging.DEBUG, None),
        ("error.log", logging.ERROR, None),
        ("warning.log", logging.WARNING, logging.WARNING),
    )
    for filename, level, exact_level in handlers:
        handler = RotatingFileHandler(
            LOG_DIR / filename,
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
        )
        handler.setLevel(level)
        if exact_level is not None:
            handler.addFilter(ExactLevelFilter(exact_level))
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    return logger


logger = configure_logging()
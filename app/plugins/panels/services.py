from pathlib import Path

from app.core.logging import LOG_DIR, LOG_FILES
from app.plugins.panels.models import LogUpdate


MAX_LOG_READ_BYTES = 64 * 1024


class PanelService:
    def has_log(self, log_type: str) -> bool:
        return log_type in LOG_FILES

    def read_log(self, log_type: str, offset: int, generation: str) -> LogUpdate:
        filename = LOG_FILES.get(log_type)
        if filename is None:
            raise KeyError(log_type)

        path = Path(LOG_DIR) / filename
        stat = path.stat()
        current_generation = f"{stat.st_dev}:{stat.st_ino}"
        reset = generation != current_generation or offset > stat.st_size
        if reset:
            offset = max(0, stat.st_size - MAX_LOG_READ_BYTES)

        with path.open("rb") as log_file:
            log_file.seek(offset)
            if reset and offset:
                log_file.readline(MAX_LOG_READ_BYTES)
            content = log_file.read(MAX_LOG_READ_BYTES)
            next_offset = log_file.tell()

        return {
            "content": content.decode("utf-8", errors="replace"),
            "offset": next_offset,
            "generation": current_generation,
            "reset": reset,
        }

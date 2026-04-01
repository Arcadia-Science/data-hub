from __future__ import annotations
import logging
from pathlib import Path

DEFAULT_LOG_FORMAT_STRING = "%(asctime)s | %(levelname)s | %(name)s | %(message)s"


def get_named_logger(
    name: str, level: int = logging.INFO, log_file_path: Path | None = None
) -> logging.Logger:
    """Returns a named logger with a stream handler and optional file handler.

    Args:
        name: The name of the logger.
        level: The logging level. Defaults to ``logging.INFO``.
        log_file_path: Optional path for a file handler.

    Returns:
        A configured logger instance.
    """
    logger = logging.getLogger(name)
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(level)

    formatter = logging.Formatter(DEFAULT_LOG_FORMAT_STRING)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)

    if log_file_path:
        file_handler = logging.FileHandler(log_file_path)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    return logger

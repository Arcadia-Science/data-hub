import logging
from pathlib import Path

DEFAULT_LOG_FORMAT_STRING = "%(asctime)s | %(levelname)s | %(name)s | %(message)s"


def get_named_logger(
    name: str, level: int = logging.INFO, log_file_path: Path | None = None
) -> logging.Logger:
    """Returns a named logger.

    Args:
        name (str):
            The name of the logger.
        level (int, optional):
            The level of the logger. Defaults to `logging.INFO`.
        log_file_path (Path, optional):
            The path to the log file. If `None`, no file handler will be added.

    Returns:
        logging.Logger: The named logger.
    """
    logger = logging.getLogger(name)

    # Clear any existing handlers and prevent propagation.
    logger.handlers.clear()
    logger.propagate = False

    # Set the logger level.
    logger.setLevel(level)
    formatter = logging.Formatter(DEFAULT_LOG_FORMAT_STRING)

    # Stream handler.
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)

    # File handler.
    if log_file_path:
        file_handler = logging.FileHandler(log_file_path)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    return logger

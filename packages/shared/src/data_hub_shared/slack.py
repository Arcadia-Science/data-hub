from __future__ import annotations
import logging

import requests

from data_hub_shared.config import config

logger = logging.getLogger(__name__)


def send_message(message: str) -> None:
    """Sends a message to the Slack channel via the configured webhook URL.

    Args:
        message: The message text to send.
    """
    if not config.SLACK_WEBHOOK_URL:
        logger.warning("`SLACK_WEBHOOK_URL` is not set, skipping message.")
        return

    payload = {"text": message}

    logger.info("Sending message to Slack: %s", message)
    try:
        response = requests.post(config.SLACK_WEBHOOK_URL, json=payload)
        response.raise_for_status()
        logger.info("Message sent to Slack.")
    except requests.exceptions.HTTPError:
        logger.exception("Failed to send message to Slack: %s", message)

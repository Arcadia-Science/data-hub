import requests

from data_hub_utils.config import config
from data_hub_utils.logger import get_named_logger

logger = get_named_logger(__name__)


def send_message(message: str) -> None:
    """
    Sends a message to the Slack channel specified by the `SLACK_WEBHOOK_URL` environment variable.

    Reference: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks.

    Args:
        message (str): The message to send to Slack.

    Raises:
        requests.exceptions.HTTPError: If the message fails to send to Slack.
    """
    if not config.SLACK_WEBHOOK_URL:
        logger.warning("`SLACK_WEBHOOK_URL` is not set, skipping message.")
        return

    payload = {"text": message}

    logger.info("Sending message to Slack: %s", message)
    try:
        response = requests.post(config.SLACK_WEBHOOK_URL, json=payload)
        response.raise_for_status()
        logger.info("✅ Message sent to Slack.")
    except requests.exceptions.HTTPError:
        logger.exception("❌ Failed to send message to Slack: %s", message)

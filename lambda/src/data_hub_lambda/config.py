from __future__ import annotations
import os


class LambdaConfig:
    """Lambda-specific configuration from environment variables.

    Settings shared with the watcher (AWS, S3, Slack) live in
    ``data_hub_shared.config``.
    """

    DATA_HUB_API_URL: str | None
    DATA_HUB_API_KEY: str | None

    AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN: str | None

    def __init__(self) -> None:
        self.AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN = os.getenv("AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN")
        self.DATA_HUB_API_URL = os.getenv("DATA_HUB_API_URL")
        self.DATA_HUB_API_KEY = os.getenv("DATA_HUB_API_KEY")


lambda_config = LambdaConfig()

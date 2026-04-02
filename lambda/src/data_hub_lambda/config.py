from __future__ import annotations
import os


class LambdaConfig:
    """Lambda-specific configuration from environment variables.

    Settings shared with the watcher (AWS, S3, Slack) live in
    ``data_hub_shared.config``.
    """

    # Legacy — used by Notion and Ganymede workflows (removed after full migration).
    GANYMEDE_API_KEY: str | None
    NOTION_API_SECRET: str | None
    NOTION_PAGE_ID: str | None
    AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN: str | None

    # Data Hub API — used by migrated per-file workflows.
    DATA_HUB_API_URL: str | None
    DATA_HUB_API_KEY: str | None

    def __init__(self) -> None:
        self.GANYMEDE_API_KEY = os.getenv("GANYMEDE_API_KEY")
        self.NOTION_API_SECRET = os.getenv("NOTION_API_SECRET")
        self.NOTION_PAGE_ID = os.getenv("NOTION_PAGE_ID")
        self.AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN = os.getenv("AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN")
        self.DATA_HUB_API_URL = os.getenv("DATA_HUB_API_URL")
        self.DATA_HUB_API_KEY = os.getenv("DATA_HUB_API_KEY")


lambda_config = LambdaConfig()

from __future__ import annotations
import os
from pathlib import Path


class Config:
    """Shared configuration from environment variables.

    Contains settings used by both the Lambda function and the watcher.
    Lambda-specific settings (Ganymede, Notion, Data Hub API) live in
    ``data_hub_lambda.config``.
    """

    LOCAL_DATA_DIRPATH: Path
    LOCAL_RAW_DATA_DIRPATH: Path
    LOCAL_PROCESSED_DATA_DIRPATH: Path

    AWS_REGION: str | None
    AWS_ACCESS_KEY_ID: str | None
    AWS_SECRET_ACCESS_KEY: str | None
    AWS_SESSION_TOKEN: str | None

    AWS_S3_RAW_DATA_BUCKET: str | None
    AWS_S3_PROCESSED_DATA_BUCKET: str | None

    SLACK_WEBHOOK_URL: str | None

    def __init__(self) -> None:
        self.LOCAL_DATA_DIRPATH = Path(os.getenv("LOCAL_DATA_DIRPATH") or "/tmp/data")
        self.LOCAL_RAW_DATA_DIRPATH = self.LOCAL_DATA_DIRPATH / "raw-data"
        self.LOCAL_PROCESSED_DATA_DIRPATH = self.LOCAL_DATA_DIRPATH / "processed-data"

        self.AWS_REGION = os.getenv("AWS_REGION")
        self.AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
        self.AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
        self.AWS_SESSION_TOKEN = os.getenv("AWS_SESSION_TOKEN")

        self.AWS_S3_RAW_DATA_BUCKET = os.getenv("AWS_S3_RAW_DATA_BUCKET")
        self.AWS_S3_PROCESSED_DATA_BUCKET = os.getenv("AWS_S3_PROCESSED_DATA_BUCKET")

        self.SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL")


config = Config()

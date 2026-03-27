import os
from pathlib import Path


class Config:
    # Local file paths.
    LOCAL_DATA_DIRPATH: Path
    LOCAL_RAW_DATA_DIRPATH: Path
    LOCAL_PROCESSED_DATA_DIRPATH: Path

    # AWS.
    AWS_REGION: str | None
    AWS_ACCESS_KEY_ID: str | None
    AWS_SECRET_ACCESS_KEY: str | None
    AWS_SESSION_TOKEN: str | None  # Required for role-based credentials.

    # AWS S3.
    AWS_S3_RAW_DATA_BUCKET: str | None
    AWS_S3_PROCESSED_DATA_BUCKET: str | None

    # AWS Lambda.
    AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN: str | None

    # Ganymede.
    GANYMEDE_API_KEY: str | None

    # Notion.
    NOTION_API_SECRET: str | None
    NOTION_PAGE_ID: str | None

    # Slack.
    SLACK_WEBHOOK_URL: str | None

    def __init__(self):
        self.LOCAL_DATA_DIRPATH = Path(os.getenv("LOCAL_DATA_DIRPATH") or "/tmp/data")
        self.LOCAL_RAW_DATA_DIRPATH = self.LOCAL_DATA_DIRPATH / "raw-data"
        self.LOCAL_PROCESSED_DATA_DIRPATH = self.LOCAL_DATA_DIRPATH / "processed-data"

        self.AWS_REGION = os.getenv("AWS_REGION")
        self.AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
        self.AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
        self.AWS_SESSION_TOKEN = os.getenv("AWS_SESSION_TOKEN")

        self.AWS_S3_RAW_DATA_BUCKET = os.getenv("AWS_S3_RAW_DATA_BUCKET")
        self.AWS_S3_PROCESSED_DATA_BUCKET = os.getenv("AWS_S3_PROCESSED_DATA_BUCKET")

        self.AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN = os.getenv("AWS_LAMBDA_FUNCTION_URL_AUTH_TOKEN")

        self.GANYMEDE_API_KEY = os.getenv("GANYMEDE_API_KEY")

        self.NOTION_API_SECRET = os.getenv("NOTION_API_SECRET")
        self.NOTION_PAGE_ID = os.getenv("NOTION_PAGE_ID")

        self.SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL")


config = Config()

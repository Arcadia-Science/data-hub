from __future__ import annotations
import os


class LambdaConfig:
    DATA_HUB_API_URL: str | None
    DATA_HUB_API_KEY: str | None
    LAMBDA_INVOKE_TOKEN: str | None
    AWS_S3_ARCHIVES_BUCKET: str | None

    def __init__(self) -> None:
        self.DATA_HUB_API_URL = os.getenv("DATA_HUB_API_URL")
        self.DATA_HUB_API_KEY = os.getenv("DATA_HUB_API_KEY")
        self.LAMBDA_INVOKE_TOKEN = os.getenv("LAMBDA_INVOKE_TOKEN")
        self.AWS_S3_ARCHIVES_BUCKET = os.getenv("AWS_S3_ARCHIVES_BUCKET")


lambda_config = LambdaConfig()

from __future__ import annotations
import os


class LambdaConfig:
    DATA_HUB_API_URL: str | None
    DATA_HUB_API_KEY: str | None

    def __init__(self) -> None:
        self.DATA_HUB_API_URL = os.getenv("DATA_HUB_API_URL")
        self.DATA_HUB_API_KEY = os.getenv("DATA_HUB_API_KEY")


lambda_config = LambdaConfig()

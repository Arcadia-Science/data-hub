from __future__ import annotations
import os


class LambdaConfig:
    DATA_HUB_API_URL: str | None
    DATA_HUB_API_KEY: str | None
    # The archives bucket this Lambda is allowed to write to. Used as an
    # allow-list inside ``_handle_build_archive`` so a caller can't
    # redirect zip writes at an unrelated bucket the role might
    # otherwise have PutObject on. Set automatically by SAM via
    # ``!Ref ArchivesBucket``.
    AWS_S3_ARCHIVES_BUCKET: str | None
    # `staging` or `production`; labels the mount-wait metric.
    DATA_HUB_ENVIRONMENT: str | None
    # Empty when the raw bucket is not mounted. Processors then download.
    RAW_DATA_MOUNT_PATH: str

    def __init__(self) -> None:
        self.DATA_HUB_API_URL = os.getenv("DATA_HUB_API_URL")
        self.DATA_HUB_API_KEY = os.getenv("DATA_HUB_API_KEY")
        self.AWS_S3_ARCHIVES_BUCKET = os.getenv("AWS_S3_ARCHIVES_BUCKET")
        self.DATA_HUB_ENVIRONMENT = os.getenv("DATA_HUB_ENVIRONMENT")
        self.RAW_DATA_MOUNT_PATH = os.getenv("RAW_DATA_MOUNT_PATH") or ""


lambda_config = LambdaConfig()

import mimetypes
from pathlib import Path
from urllib.parse import urlparse

import boto3
from data_hub_utils.config import config

s3_client = boto3.client(
    "s3",
    aws_access_key_id=config.AWS_ACCESS_KEY_ID,
    aws_secret_access_key=config.AWS_SECRET_ACCESS_KEY,
    aws_session_token=config.AWS_SESSION_TOKEN,
    region_name=config.AWS_REGION,
)


def _parse_s3_uri(s3_uri: str) -> tuple[str, str]:
    """Splits an S3 URI into bucket name and remainder of URI.

    Args:
        s3_uri (str): The S3 URI to parse e.g. s3://bucket/prefix.

    Returns:
        tuple[str, str]: A tuple of (bucket, remainder_of_uri), e.g.
        ("my-bucket", "path/to/file.txt") or ("my-bucket", "path/to/folder/").
    """
    parsed = urlparse(s3_uri)
    if parsed.scheme != "s3":
        raise ValueError(f"Invalid S3 URI: {s3_uri}")
    return parsed.netloc, parsed.path.lstrip("/")


def _get_extra_args(file_path: Path) -> dict[str, str]:
    """Returns the appropriate extra arguments for the S3 upload.

    If the file's MIME type can be determined, it is set as the Content-Type.

    If the file is an image, the Content-Disposition is set to inline to ensure that
    the image displays inline instead of downloading.

    Args:
        file_path (Path): The path to the file to upload.

    Returns:
        dict[str, str]: A dictionary of extra arguments to pass to the S3 upload.
    """
    extra_args = {}
    content_type = mimetypes.guess_type(file_path)[0]

    if content_type:
        extra_args["ContentType"] = content_type

        # Ensure that images display inline instead of downloading.
        if content_type.startswith("image/"):
            extra_args["ContentDisposition"] = "inline"

    return extra_args


def download_file(s3_uri: str, local_path: Path) -> None:
    """Downloads a file from S3 to the given local path.

    Args:
        s3_uri (str): The S3 URI of the object to download e.g. s3://bucket/object_key.
        local_path (Path): The local file path where the downloaded file will be saved.
    """
    bucket, object_key = _parse_s3_uri(s3_uri)
    local_path.parent.mkdir(parents=True, exist_ok=True)
    s3_client.download_file(bucket, object_key, local_path)


def download_folder(s3_uri_prefix: str, local_path: Path) -> None:
    """Downloads all files from an S3 prefix to the given local directory.

    Args:
        s3_uri_prefix (str): The S3 URI prefix of the folder to download e.g. s3://bucket/prefix/.
        local_path (Path): The local directory path where the downloaded files will be saved.
    """
    _, prefix = _parse_s3_uri(s3_uri_prefix)
    local_path.mkdir(parents=True, exist_ok=True)

    if prefix and not prefix.endswith("/"):
        prefix += "/"

    objects = list_objects(s3_uri_prefix)
    if not objects:
        print(f"No files found in S3 prefix: {s3_uri_prefix}")
        return

    # TODO: We should probably download objects in parallel.
    # TODO: Implement a progress bar.
    for object_uri in objects:
        _, object_key = _parse_s3_uri(object_uri)
        if object_key.endswith("/"):
            continue

        relative_path = object_key[len(prefix) :] if object_key.startswith(prefix) else object_key
        download_file(object_uri, local_path / relative_path)


def upload_file(local_path: Path, s3_uri: str) -> None:
    """Uploads the given file to the given S3 URI.

    Args:
        local_path (Path): The local file to upload.
        s3_uri (str): The S3 URI to upload to e.g. s3://bucket/prefix/.
    """
    bucket, prefix = _parse_s3_uri(s3_uri)
    extra_args = _get_extra_args(local_path)
    s3_client.upload_file(local_path, bucket, prefix, ExtraArgs=extra_args)


def upload_folder(local_path: Path, s3_uri_prefix: str) -> None:
    """Uploads the given folder to S3.

    The object key for each file is constructed by concatenating the given S3 URI prefix
    with the relative path of the file from the given local path. This will result in a
    hierarchy in S3 that mirrors the local file structure.

    Args:
        local_path (Path): The local folder to upload.
        s3_uri_prefix (str): The S3 URI prefix to use for each file's object key.
    """
    for file_path in local_path.rglob("*"):
        if file_path.is_file():
            relative_path = file_path.relative_to(local_path)
            object_uri = f"{s3_uri_prefix}/{relative_path}".replace("\\", "/")
            upload_file(file_path, object_uri)


def list_objects(s3_uri_prefix: str, suffix: str = "") -> list[str]:
    """Returns a list of all objects with the given S3 prefix, optionally filtered by suffix.

    Args:
        s3_uri_prefix (str):
            S3 URI prefix to search for objects (e.g., "s3://bucket/prefix/").
        suffix (str):
            Optional suffix to filter objects by.

    Returns:
        list[str]:
            A list of S3 URIs for the objects, e.g.
            `["s3://bucket/prefix/file1.txt", "s3://bucket/prefix/file2.txt"]`.
    """
    bucket, prefix = _parse_s3_uri(s3_uri_prefix)

    object_keys = []
    paginator = s3_client.get_paginator("list_objects_v2")

    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        if "Contents" in page:
            for obj in page["Contents"]:
                key = obj["Key"]
                if not suffix or key.endswith(suffix):
                    object_keys.append(f"s3://{bucket}/{key}")

    return object_keys


def list_folders(s3_uri_prefix: str) -> list[str]:
    """Returns a list of S3 URI prefixes that are "nested" under the given S3 prefix.

    For example, if the given S3 URI prefix is "s3://bucket/data/", this method
    might return ["s3://bucket/data/folder1/", "s3://bucket/data/folder2/"].

    Args:
        s3_uri_prefix (str): S3 URI prefix, e.g. "s3://bucket/data/".

    Returns:
        list[str]: A list of S3 URIs for the "nested" folders, each with a trailing slash,
        e.g. ["s3://bucket/data/folder1/", "s3://bucket/data/folder2/"].
    """
    bucket, prefix = _parse_s3_uri(s3_uri_prefix)

    # Ensure prefix ends with / for proper folder listing.
    if prefix and not prefix.endswith("/"):
        prefix = prefix + "/"

    folders = set()
    paginator = s3_client.get_paginator("list_objects_v2")

    for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        if "CommonPrefixes" in page:
            for common_prefix in page["CommonPrefixes"]:
                folder_prefix = common_prefix["Prefix"]
                folders.add(f"s3://{bucket}/{folder_prefix}")

    return sorted(list(folders))

"""Local-disk S3 mirror used by the `data-hub-process handler` CLI.

A "mirror" is a directory whose layout matches an S3 bucket layout —
``<root>/<bucket>/<key>``. Pairing this with monkey-patches of
``data_hub_shared.s3_utils.download_file`` / ``upload_file`` lets a
developer drive ``lambda_handler`` end-to-end against the local web app
without LocalStack, MinIO, or real AWS credentials. See
``developer-docs/local-development.md`` for the full workflow.

Kept intentionally small: a path mapper, a context manager that swaps
the two ``s3_utils`` entry points for ``shutil.copy2`` calls against the
mirror, and a ``MagicMock`` ``Context`` factory shared with the CLI.
The integration test conftest already mocks the same surface (see
``lambda/tests/integration/conftest.py``); this module is the
non-pytest equivalent.
"""

from __future__ import annotations
import shutil
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from aws_lambda_typing.context import Context

from data_hub_shared.s3_utils import parse_s3_uri


def mirror_path(root: Path, s3_uri: str) -> Path:
    """Map an ``s3://<bucket>/<key>`` URI to ``<root>/<bucket>/<key>``.

    The bucket name becomes the first path segment so a single mirror
    root can host both raw and processed buckets side-by-side, matching
    how a real account isolates them.
    """
    bucket, key = parse_s3_uri(s3_uri)
    return root / bucket / key


@contextmanager
def patched_s3(root: Path) -> Generator[None, None, None]:
    """Patch S3 download/upload to copy from/to a local mirror directory.

    ``download_file(s3_uri, local_path)`` copies ``<root>/<bucket>/<key>``
    into ``local_path``. ``upload_file(local_path, s3_uri)`` copies
    ``local_path`` into ``<root>/<bucket>/<key>``. Both create parent
    directories on the destination side so the caller never has to
    pre-create them.

    A missing source on download raises ``FileNotFoundError`` with the
    expected mirror path so the developer sees exactly where to drop
    their fixture if they invoked the handler without staging first.
    """

    def _fake_download(s3_uri: str, local_path: Path, **_: Any) -> None:
        src = mirror_path(root, s3_uri)
        if not src.exists():
            raise FileNotFoundError(
                f"No file staged at {src} for {s3_uri}. "
                f"Stage one with `--source` or copy it into the mirror."
            )
        local_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, local_path)

    def _fake_upload(local_path: Path, s3_uri: str, **_: Any) -> None:
        dest = mirror_path(root, s3_uri)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local_path, dest)

    with (
        patch("data_hub_shared.s3_utils.download_file", side_effect=_fake_download),
        patch("data_hub_shared.s3_utils.upload_file", side_effect=_fake_upload),
    ):
        yield


def make_mock_context() -> MagicMock:
    """Return a ``MagicMock`` shaped like ``aws_lambda_typing.context.Context``.

    The ``lambda_handler`` only reads a handful of attributes off the
    context (logging metadata), so a thin mock with the typical AWS
    identifiers is enough — and keeping it here means the CLI doesn't
    need to import ``unittest.mock`` directly.
    """
    ctx = MagicMock(spec=Context)
    ctx.invoked_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:data-hub-lambda"
    ctx.log_group_name = "/aws/lambda/data-hub-lambda"
    ctx.log_stream_name = "local-cli/handler"
    ctx.function_name = "data-hub-lambda"
    ctx.function_version = "$LATEST"
    ctx.memory_limit_in_mb = "256"
    ctx.aws_request_id = "local-cli-request"
    return ctx

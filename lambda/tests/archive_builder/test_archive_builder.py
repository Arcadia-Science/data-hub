"""Unit tests for `archive_builder` — the Lambda's run-zip pipeline.

We exercise the multipart wrapper with an in-memory stub S3 client rather
than spinning up moto. The wrapper accepts any object with the small subset
of the boto3 client API it actually calls (create_multipart_upload,
upload_part, complete_multipart_upload, abort_multipart_upload, get_object),
which keeps these tests self-contained and fast.
"""

from __future__ import annotations
import io
import zipfile
from typing import Any

import pytest

from data_hub_lambda.archive_builder import (
    ArchiveFile,
    BuildArchiveRequest,
    build_run_archive,
    parse_build_request,
)

# ---------------------------------------------------------------------------
# Stub S3 client
# ---------------------------------------------------------------------------


class _StubS3Body:
    def __init__(self, data: bytes) -> None:
        self._buf = io.BytesIO(data)

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n if n != -1 else 1 << 30)

    def close(self) -> None:
        self._buf.close()


class StubS3Client:
    """Minimal in-memory stand-in for the boto3 S3 client."""

    def __init__(self, source_objects: dict[tuple[str, str], bytes] | None = None) -> None:
        self.source_objects: dict[tuple[str, str], bytes] = source_objects or {}
        self.uploaded_objects: dict[tuple[str, str], bytes] = {}
        # In-flight multipart uploads keyed by upload_id.
        self._mpu: dict[str, dict[str, Any]] = {}
        self._next_upload_id = 0
        self.aborted: list[str] = []
        self.fail_part_at: int | None = None
        self.calls: list[tuple[str, dict[str, Any]]] = []

    # -- source side --
    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.calls.append(("get_object", {"Bucket": Bucket, "Key": Key}))
        try:
            data = self.source_objects[(Bucket, Key)]
        except KeyError as exc:
            raise FileNotFoundError(f"missing fixture s3://{Bucket}/{Key}") from exc
        return {"Body": _StubS3Body(data)}

    # -- destination side --
    def create_multipart_upload(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self._next_upload_id += 1
        upload_id = f"upload-{self._next_upload_id}"
        self._mpu[upload_id] = {"Bucket": Bucket, "Key": Key, "parts": {}}
        self.calls.append(("create_multipart_upload", {"Bucket": Bucket, "Key": Key}))
        return {"UploadId": upload_id}

    def upload_part(
        self, *, Bucket: str, Key: str, UploadId: str, PartNumber: int, Body: bytes
    ) -> dict[str, Any]:
        self.calls.append(
            (
                "upload_part",
                {
                    "Bucket": Bucket,
                    "Key": Key,
                    "UploadId": UploadId,
                    "PartNumber": PartNumber,
                    "len": len(Body),
                },
            )
        )
        if self.fail_part_at is not None and PartNumber == self.fail_part_at:
            raise RuntimeError(f"injected upload_part failure on part {PartNumber}")
        self._mpu[UploadId]["parts"][PartNumber] = Body
        return {"ETag": f'"etag-{UploadId}-{PartNumber}"'}

    def complete_multipart_upload(
        self,
        *,
        Bucket: str,
        Key: str,
        UploadId: str,
        MultipartUpload: dict[str, Any],
    ) -> dict[str, Any]:
        parts: dict[int, bytes] = self._mpu[UploadId]["parts"]
        # Reassemble in part-number order to mirror S3's behavior.
        ordered = [parts[p["PartNumber"]] for p in MultipartUpload["Parts"]]
        body = b"".join(ordered)
        self.uploaded_objects[(Bucket, Key)] = body
        del self._mpu[UploadId]
        self.calls.append(("complete_multipart_upload", {"Bucket": Bucket, "Key": Key}))
        return {}

    def abort_multipart_upload(self, *, Bucket: str, Key: str, UploadId: str) -> dict[str, Any]:
        self.aborted.append(UploadId)
        self._mpu.pop(UploadId, None)
        self.calls.append(("abort_multipart_upload", {"Bucket": Bucket, "Key": Key}))
        return {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_request(
    files: list[ArchiveFile],
    *,
    instrument_id: str = "akta-fplc",
    run_id: str = "RUN001",
    source_bucket: str = "raw-bucket",
    destination_bucket: str = "archives-bucket",
) -> BuildArchiveRequest:
    destination_key = f"runs/{instrument_id}/{run_id}/abc.zip"
    return BuildArchiveRequest(
        instrument_id=instrument_id,
        run_id=run_id,
        source_bucket=source_bucket,
        destination_bucket=destination_bucket,
        destination_key=destination_key,
        files=files,
    )


# ---------------------------------------------------------------------------
# Happy-path tests
# ---------------------------------------------------------------------------


class TestBuildRunArchive:
    def test_single_small_file(self) -> None:
        body = b"hello, world\n" * 10
        s3 = StubS3Client({("raw-bucket", "akta-fplc/RUN001/data.csv"): body})
        request = _make_request([ArchiveFile(key="akta-fplc/RUN001/data.csv", name="data.csv")])

        result = build_run_archive(request, s3_client=s3)

        assert result.archive_bucket == "archives-bucket"
        assert result.archive_key == "runs/akta-fplc/RUN001/abc.zip"
        zipped = s3.uploaded_objects[("archives-bucket", "runs/akta-fplc/RUN001/abc.zip")]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert zf.namelist() == ["data.csv"]
            assert zf.read("data.csv") == body

    def test_multiple_files_preserve_contents(self) -> None:
        s3 = StubS3Client(
            {
                ("raw-bucket", "akta-fplc/RUN001/a.csv"): b"alpha",
                ("raw-bucket", "akta-fplc/RUN001/b.csv"): b"bravo bravo bravo",
                ("raw-bucket", "akta-fplc/RUN001/c.bin"): bytes(range(256)),
            }
        )
        request = _make_request(
            [
                ArchiveFile(key="akta-fplc/RUN001/a.csv", name="a.csv"),
                ArchiveFile(key="akta-fplc/RUN001/b.csv", name="b.csv"),
                ArchiveFile(key="akta-fplc/RUN001/c.bin", name="c.bin"),
            ]
        )

        build_run_archive(request, s3_client=s3)

        zipped = s3.uploaded_objects[("archives-bucket", "runs/akta-fplc/RUN001/abc.zip")]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert sorted(zf.namelist()) == ["a.csv", "b.csv", "c.bin"]
            assert zf.read("a.csv") == b"alpha"
            assert zf.read("b.csv") == b"bravo bravo bravo"
            assert zf.read("c.bin") == bytes(range(256))

    def test_large_file_spans_multiple_parts(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Drop the part size to 1 KB so we can verify multipart spanning
        # without allocating the production 16 MB threshold.
        import data_hub_lambda.archive_builder as ab

        monkeypatch.setattr(ab, "_PART_SIZE_BYTES", 1024)
        body = b"abcdefghij" * 1000  # 10 KB → at least 10 parts
        s3 = StubS3Client({("raw-bucket", "akta-fplc/RUN001/big.bin"): body})
        request = _make_request([ArchiveFile(key="akta-fplc/RUN001/big.bin", name="big.bin")])

        build_run_archive(request, s3_client=s3)

        upload_calls = [c for c in s3.calls if c[0] == "upload_part"]
        assert len(upload_calls) >= 10
        zipped = s3.uploaded_objects[("archives-bucket", "runs/akta-fplc/RUN001/abc.zip")]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert zf.read("big.bin") == body


# ---------------------------------------------------------------------------
# Failure-path tests
# ---------------------------------------------------------------------------


class TestBuildRunArchiveFailures:
    def test_aborts_multipart_on_upload_part_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import data_hub_lambda.archive_builder as ab

        monkeypatch.setattr(ab, "_PART_SIZE_BYTES", 512)
        s3 = StubS3Client({("raw-bucket", "akta-fplc/RUN001/x.bin"): b"x" * 4096})
        s3.fail_part_at = 2  # fail on the second part flush
        request = _make_request([ArchiveFile(key="akta-fplc/RUN001/x.bin", name="x.bin")])

        with pytest.raises(RuntimeError):
            build_run_archive(request, s3_client=s3)

        # Multipart upload was aborted, no completed object exists.
        assert s3.aborted, "expected abort_multipart_upload to be called"
        assert ("archives-bucket", "runs/akta-fplc/RUN001/abc.zip") not in s3.uploaded_objects

    def test_refuses_to_exceed_max_parts(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # With a 256-byte part size and a 4-part cap, an 8 KB file forces the
        # writer past the cap mid-stream. We expect a clear ValueError before
        # S3 would ever return InvalidArgument, and the upload to be aborted.
        import data_hub_lambda.archive_builder as ab

        monkeypatch.setattr(ab, "_PART_SIZE_BYTES", 256)
        monkeypatch.setattr(ab, "_MAX_PARTS", 4)
        # _MAX_TOTAL_BYTES is derived at module load; recompute so the
        # inter-file byte guard doesn't fire first.
        monkeypatch.setattr(ab, "_MAX_TOTAL_BYTES", 256 * 4)
        s3 = StubS3Client({("raw-bucket", "akta-fplc/RUN001/big.bin"): b"x" * 8192})
        request = _make_request([ArchiveFile(key="akta-fplc/RUN001/big.bin", name="big.bin")])

        with pytest.raises(ValueError, match="multipart upload cap"):
            build_run_archive(request, s3_client=s3)

        assert s3.aborted, "expected abort_multipart_upload to be called"
        assert ("archives-bucket", "runs/akta-fplc/RUN001/abc.zip") not in s3.uploaded_objects


# ---------------------------------------------------------------------------
# parse_build_request validation
# ---------------------------------------------------------------------------


class TestParseBuildRequest:
    def _base_payload(self) -> dict[str, Any]:
        return {
            "instrument_id": "akta-fplc",
            "run_id": "RUN001",
            "source_bucket": "raw-bucket",
            "destination_bucket": "archives-bucket",
            "destination_key": "runs/akta-fplc/RUN001/abc.zip",
            "files": [{"key": "akta-fplc/RUN001/data.csv", "name": "data.csv"}],
        }

    def test_accepts_valid_payload(self) -> None:
        request = parse_build_request(self._base_payload())
        assert request.files == [ArchiveFile(key="akta-fplc/RUN001/data.csv", name="data.csv")]

    def test_rejects_missing_field(self) -> None:
        payload = self._base_payload()
        payload.pop("instrument_id")
        with pytest.raises(ValueError, match="Missing required field"):
            parse_build_request(payload)

    def test_rejects_empty_files(self) -> None:
        payload = self._base_payload()
        payload["files"] = []
        with pytest.raises(ValueError, match="non-empty array"):
            parse_build_request(payload)

    def test_rejects_key_outside_run_prefix(self) -> None:
        payload = self._base_payload()
        # Try to slip a key from a different run into the archive — must fail
        # so a leaked invoke token can't exfiltrate cross-run data.
        payload["files"] = [{"key": "other-instrument/RUN999/data.csv", "name": "data.csv"}]
        with pytest.raises(ValueError, match="does not belong to run"):
            parse_build_request(payload)

    def test_rejects_name_with_path_traversal(self) -> None:
        payload = self._base_payload()
        payload["files"] = [{"key": "akta-fplc/RUN001/data.csv", "name": "../escape.csv"}]
        with pytest.raises(ValueError, match="Invalid archive entry name"):
            parse_build_request(payload)

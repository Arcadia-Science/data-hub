"""Unit tests for `archive_builder` — the Lambda's run-zip pipeline.

We exercise the multipart wrapper with an in-memory stub S3 client rather
than spinning up moto. The wrapper accepts any object with the small subset
of the boto3 client API it actually calls (create_multipart_upload,
upload_part, complete_multipart_upload, abort_multipart_upload, get_object),
which keeps these tests self-contained and fast.
"""

from __future__ import annotations
import io
import threading
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

        # Concurrency instrumentation for the prefetch tests. `get_object` can
        # now run on worker threads, so guard shared state with a lock and
        # track peak in-flight GETs + the thread each key was fetched on.
        self._lock = threading.Lock()
        self._concurrent_get = 0
        self.max_concurrent_get = 0
        self.get_threads: dict[str, int] = {}
        # When set, every get_object rendezvouses here before returning, so a
        # test can assert N fetches genuinely overlap (a serial implementation
        # would deadlock and time out).
        self.get_barrier: threading.Barrier | None = None

    # -- source side --
    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        with self._lock:
            self.calls.append(("get_object", {"Bucket": Bucket, "Key": Key}))
            self.get_threads[Key] = threading.get_ident()
            self._concurrent_get += 1
            self.max_concurrent_get = max(self.max_concurrent_get, self._concurrent_get)
        try:
            if self.get_barrier is not None:
                self.get_barrier.wait(timeout=5)
            try:
                data = self.source_objects[(Bucket, Key)]
            except KeyError as exc:
                raise FileNotFoundError(f"missing fixture s3://{Bucket}/{Key}") from exc
            return {"Body": _StubS3Body(data)}
        finally:
            with self._lock:
                self._concurrent_get -= 1

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
    destination_bucket: str = "archives-bucket",
) -> BuildArchiveRequest:
    destination_key = f"runs/{instrument_id}/{run_id}/abc.zip"
    return BuildArchiveRequest(
        instrument_id=instrument_id,
        run_id=run_id,
        destination_bucket=destination_bucket,
        destination_key=destination_key,
        files=files,
    )


def _file(
    key: str,
    name: str,
    source_bucket: str = "raw-bucket",
    size_bytes: int | None = None,
) -> ArchiveFile:
    return ArchiveFile(key=key, name=name, source_bucket=source_bucket, size_bytes=size_bytes)


# ---------------------------------------------------------------------------
# Happy-path tests
# ---------------------------------------------------------------------------


class TestBuildRunArchive:
    def test_single_small_file(self) -> None:
        body = b"hello, world\n" * 10
        s3 = StubS3Client({("raw-bucket", "akta-fplc/RUN001/data.csv"): body})
        request = _make_request([_file("akta-fplc/RUN001/data.csv", "data.csv")])

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
                _file("akta-fplc/RUN001/a.csv", "a.csv"),
                _file("akta-fplc/RUN001/b.csv", "b.csv"),
                _file("akta-fplc/RUN001/c.bin", "c.bin"),
            ]
        )

        build_run_archive(request, s3_client=s3)

        zipped = s3.uploaded_objects[("archives-bucket", "runs/akta-fplc/RUN001/abc.zip")]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert sorted(zf.namelist()) == ["a.csv", "b.csv", "c.bin"]
            assert zf.read("a.csv") == b"alpha"
            assert zf.read("b.csv") == b"bravo bravo bravo"
            assert zf.read("c.bin") == bytes(range(256))

    def test_files_from_multiple_source_buckets(self) -> None:
        # Mixed-bucket runs are the common case for instruments that produce
        # processed artifacts (SpectraMax CSVs, Hina JPGs, Azure 600 PNGs):
        # raw inputs live in the raw bucket, processor output in the
        # processed bucket. A single archive must zip across both.
        s3 = StubS3Client(
            {
                ("raw-bucket", "spectramax-id3-plate-reader/RUN42/plate.xls"): b"raw-bytes",
                (
                    "processed-bucket",
                    "spectramax-id3-plate-reader/RUN42/RUN42_raw_well_data.csv",
                ): b"processed-bytes",
            }
        )
        request = _make_request(
            [
                ArchiveFile(
                    key="spectramax-id3-plate-reader/RUN42/plate.xls",
                    name="plate.xls",
                    source_bucket="raw-bucket",
                ),
                ArchiveFile(
                    key="spectramax-id3-plate-reader/RUN42/RUN42_raw_well_data.csv",
                    name="RUN42_raw_well_data.csv",
                    source_bucket="processed-bucket",
                ),
            ],
            instrument_id="spectramax-id3-plate-reader",
            run_id="RUN42",
        )

        build_run_archive(request, s3_client=s3)

        zipped = s3.uploaded_objects[
            ("archives-bucket", "runs/spectramax-id3-plate-reader/RUN42/abc.zip")
        ]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert sorted(zf.namelist()) == [
                "RUN42_raw_well_data.csv",
                "plate.xls",
            ]
            assert zf.read("plate.xls") == b"raw-bytes"
            assert zf.read("RUN42_raw_well_data.csv") == b"processed-bytes"

        # Each get_object call must target the bucket the file declared,
        # not a single shared source bucket.
        get_calls = [c for c in s3.calls if c[0] == "get_object"]
        buckets = {c[1]["Bucket"] for c in get_calls}
        assert buckets == {"raw-bucket", "processed-bucket"}

    def test_large_file_spans_multiple_parts(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Drop the part size to 1 KB so we can verify multipart spanning
        # without allocating the production 16 MB threshold.
        import data_hub_lambda.archive_builder as ab

        monkeypatch.setattr(ab, "_PART_SIZE_BYTES", 1024)
        body = b"abcdefghij" * 1000  # 10 KB → at least 10 parts
        s3 = StubS3Client({("raw-bucket", "akta-fplc/RUN001/big.bin"): body})
        request = _make_request([_file("akta-fplc/RUN001/big.bin", "big.bin")])

        build_run_archive(request, s3_client=s3)

        upload_calls = [c for c in s3.calls if c[0] == "upload_part"]
        assert len(upload_calls) >= 10
        zipped = s3.uploaded_objects[("archives-bucket", "runs/akta-fplc/RUN001/abc.zip")]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert zf.read("big.bin") == body


# ---------------------------------------------------------------------------
# Prefetch / concurrency behavior
# ---------------------------------------------------------------------------


class TestBuildRunArchivePrefetch:
    def test_many_small_files_preserve_order_and_contents(self) -> None:
        # The motivating case: thousands of tiny files. Sizes are supplied so
        # every file is prefetch-eligible. Order and contents must survive the
        # out-of-order concurrent fetches.
        count = 50
        objects: dict[tuple[str, str], bytes] = {}
        files: list[ArchiveFile] = []
        for i in range(count):
            key = f"akta-fplc/RUN001/f{i:04d}.csv"
            body = f"row-{i}\n".encode() * (i + 1)
            objects[("raw-bucket", key)] = body
            files.append(_file(key, f"f{i:04d}.csv", size_bytes=len(body)))
        s3 = StubS3Client(objects)
        request = _make_request(files)

        build_run_archive(request, s3_client=s3)

        zipped = s3.uploaded_objects[("archives-bucket", "runs/akta-fplc/RUN001/abc.zip")]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert zf.namelist() == [f"f{i:04d}.csv" for i in range(count)]
            for i in range(count):
                assert zf.read(f"f{i:04d}.csv") == f"row-{i}\n".encode() * (i + 1)

    def test_small_files_are_fetched_concurrently(self) -> None:
        # A barrier sized to the file count forces every get_object to overlap;
        # a serial fetch loop would never release the barrier and the wait()
        # would raise BrokenBarrierError / time out.
        count = 4
        objects: dict[tuple[str, str], bytes] = {}
        files: list[ArchiveFile] = []
        for i in range(count):
            key = f"akta-fplc/RUN001/f{i}.csv"
            body = f"data-{i}".encode()
            objects[("raw-bucket", key)] = body
            files.append(_file(key, f"f{i}.csv", size_bytes=len(body)))
        s3 = StubS3Client(objects)
        s3.get_barrier = threading.Barrier(count)
        request = _make_request(files)

        build_run_archive(request, s3_client=s3)

        assert s3.max_concurrent_get == count

    def test_large_file_streams_inline_on_main_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Drop the prefetch threshold so the "big" file is ineligible. Inline
        # files are fetched lazily on the calling thread (never buffered whole
        # on a worker); eligible files are fetched on a pool thread.
        import data_hub_lambda.archive_builder as ab

        monkeypatch.setattr(ab, "_PREFETCH_MAX_FILE_BYTES", 16)
        s3 = StubS3Client(
            {
                ("raw-bucket", "akta-fplc/RUN001/big.bin"): b"x" * 4096,
                ("raw-bucket", "akta-fplc/RUN001/small.csv"): b"tiny",
            }
        )
        request = _make_request(
            [
                _file("akta-fplc/RUN001/big.bin", "big.bin", size_bytes=4096),
                _file("akta-fplc/RUN001/small.csv", "small.csv", size_bytes=4),
            ]
        )
        main_ident = threading.get_ident()

        build_run_archive(request, s3_client=s3)

        # Big file streamed inline on the main thread; small file prefetched on
        # a worker thread.
        assert s3.get_threads["akta-fplc/RUN001/big.bin"] == main_ident
        assert s3.get_threads["akta-fplc/RUN001/small.csv"] != main_ident
        zipped = s3.uploaded_objects[("archives-bucket", "runs/akta-fplc/RUN001/abc.zip")]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert zf.read("big.bin") == b"x" * 4096
            assert zf.read("small.csv") == b"tiny"

    def test_unknown_size_streams_inline(self) -> None:
        # No size hint → treated as "might be huge" → inline on the main thread.
        s3 = StubS3Client({("raw-bucket", "akta-fplc/RUN001/unknown.bin"): b"payload"})
        request = _make_request([_file("akta-fplc/RUN001/unknown.bin", "unknown.bin")])
        main_ident = threading.get_ident()

        build_run_archive(request, s3_client=s3)

        assert s3.get_threads["akta-fplc/RUN001/unknown.bin"] == main_ident

    def test_mixed_small_and_large_preserve_order(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import data_hub_lambda.archive_builder as ab

        monkeypatch.setattr(ab, "_PREFETCH_MAX_FILE_BYTES", 16)
        s3 = StubS3Client(
            {
                ("raw-bucket", "akta-fplc/RUN001/a.csv"): b"alpha",
                ("raw-bucket", "akta-fplc/RUN001/big.bin"): b"B" * 100,
                ("raw-bucket", "akta-fplc/RUN001/c.csv"): b"charlie",
            }
        )
        request = _make_request(
            [
                _file("akta-fplc/RUN001/a.csv", "a.csv", size_bytes=5),
                _file("akta-fplc/RUN001/big.bin", "big.bin", size_bytes=100),
                _file("akta-fplc/RUN001/c.csv", "c.csv", size_bytes=7),
            ]
        )

        build_run_archive(request, s3_client=s3)

        zipped = s3.uploaded_objects[("archives-bucket", "runs/akta-fplc/RUN001/abc.zip")]
        with zipfile.ZipFile(io.BytesIO(zipped)) as zf:
            assert zf.namelist() == ["a.csv", "big.bin", "c.csv"]
            assert zf.read("a.csv") == b"alpha"
            assert zf.read("big.bin") == b"B" * 100
            assert zf.read("c.csv") == b"charlie"


# ---------------------------------------------------------------------------
# Failure-path tests
# ---------------------------------------------------------------------------


class TestBuildRunArchiveFailures:
    def test_aborts_multipart_on_upload_part_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import data_hub_lambda.archive_builder as ab

        monkeypatch.setattr(ab, "_PART_SIZE_BYTES", 512)
        s3 = StubS3Client({("raw-bucket", "akta-fplc/RUN001/x.bin"): b"x" * 4096})
        s3.fail_part_at = 2  # fail on the second part flush
        request = _make_request([_file("akta-fplc/RUN001/x.bin", "x.bin")])

        with pytest.raises(RuntimeError):
            build_run_archive(request, s3_client=s3)

        # Multipart upload was aborted, no completed object exists.
        assert s3.aborted, "expected abort_multipart_upload to be called"
        assert ("archives-bucket", "runs/akta-fplc/RUN001/abc.zip") not in s3.uploaded_objects

    def test_aborts_when_prefetch_get_object_fails(self) -> None:
        # An eligible (sized) file whose source object is missing fails inside
        # the worker; the future result re-raises in the main thread, which
        # must abort the multipart upload rather than leak a partial object.
        s3 = StubS3Client(
            {("raw-bucket", "akta-fplc/RUN001/present.csv"): b"here"}
            # "missing.csv" intentionally absent.
        )
        request = _make_request(
            [
                _file("akta-fplc/RUN001/present.csv", "present.csv", size_bytes=4),
                _file("akta-fplc/RUN001/missing.csv", "missing.csv", size_bytes=4),
            ]
        )

        with pytest.raises(FileNotFoundError):
            build_run_archive(request, s3_client=s3)

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
        request = _make_request([_file("akta-fplc/RUN001/big.bin", "big.bin")])

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
            "destination_bucket": "archives-bucket",
            "destination_key": "runs/akta-fplc/RUN001/abc.zip",
            "files": [
                {
                    "key": "akta-fplc/RUN001/data.csv",
                    "name": "data.csv",
                    "source_bucket": "raw-bucket",
                }
            ],
        }

    def test_accepts_valid_payload(self) -> None:
        request = parse_build_request(self._base_payload())
        assert request.files == [
            ArchiveFile(
                key="akta-fplc/RUN001/data.csv",
                name="data.csv",
                source_bucket="raw-bucket",
            )
        ]

    def test_accepts_per_file_buckets_for_multi_bucket_runs(self) -> None:
        payload = self._base_payload()
        payload["files"] = [
            {
                "key": "akta-fplc/RUN001/raw.csv",
                "name": "raw.csv",
                "source_bucket": "raw-bucket",
            },
            {
                "key": "akta-fplc/RUN001/processed.csv",
                "name": "processed.csv",
                "source_bucket": "processed-bucket",
            },
        ]
        request = parse_build_request(payload)
        assert [f.source_bucket for f in request.files] == [
            "raw-bucket",
            "processed-bucket",
        ]

    def test_falls_back_to_top_level_source_bucket_when_per_file_omitted(self) -> None:
        # Backward-compat: pre-migration callers (and the web app while it's
        # mid-rollout) send a top-level `source_bucket` and no per-file
        # field. Each file should inherit it.
        payload = self._base_payload()
        payload["source_bucket"] = "raw-bucket"
        payload["files"] = [{"key": "akta-fplc/RUN001/data.csv", "name": "data.csv"}]
        request = parse_build_request(payload)
        assert request.files[0].source_bucket == "raw-bucket"

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

    def test_rejects_files_without_source_bucket_and_no_fallback(self) -> None:
        payload = self._base_payload()
        payload["files"] = [{"key": "akta-fplc/RUN001/data.csv", "name": "data.csv"}]
        # No top-level fallback either.
        with pytest.raises(ValueError, match="source_bucket"):
            parse_build_request(payload)

    def test_rejects_source_bucket_outside_allow_list(self) -> None:
        # A caller with `lambda:InvokeFunctionUrl` shouldn't be able to
        # redirect the builder at an arbitrary bucket the Lambda role might
        # happen to have GetObject on. The handler always passes its allow-list.
        payload = self._base_payload()
        payload["files"] = [
            {
                "key": "akta-fplc/RUN001/data.csv",
                "name": "data.csv",
                "source_bucket": "evil-bucket",
            }
        ]
        with pytest.raises(ValueError, match="not in this Lambda's allow-list"):
            parse_build_request(
                payload,
                allowed_source_buckets={"raw-bucket", "processed-bucket"},
            )

    def test_accepts_source_buckets_within_allow_list(self) -> None:
        payload = self._base_payload()
        payload["files"] = [
            {
                "key": "akta-fplc/RUN001/raw.csv",
                "name": "raw.csv",
                "source_bucket": "raw-bucket",
            },
            {
                "key": "akta-fplc/RUN001/processed.csv",
                "name": "processed.csv",
                "source_bucket": "processed-bucket",
            },
        ]
        request = parse_build_request(
            payload,
            allowed_source_buckets={"raw-bucket", "processed-bucket"},
        )
        assert len(request.files) == 2

    def test_rejects_key_outside_run_prefix(self) -> None:
        payload = self._base_payload()
        # Try to slip a key from a different run into the archive — must fail
        # so a caller with `lambda:InvokeFunctionUrl` can't exfiltrate
        # cross-run data.
        payload["files"] = [
            {
                "key": "other-instrument/RUN999/data.csv",
                "name": "data.csv",
                "source_bucket": "raw-bucket",
            }
        ]
        with pytest.raises(ValueError, match="does not belong to run"):
            parse_build_request(payload)

    def test_rejects_name_with_path_traversal(self) -> None:
        payload = self._base_payload()
        payload["files"] = [
            {
                "key": "akta-fplc/RUN001/data.csv",
                "name": "../escape.csv",
                "source_bucket": "raw-bucket",
            }
        ]
        with pytest.raises(ValueError, match="Invalid archive entry name"):
            parse_build_request(payload)

    def test_parses_valid_size_bytes(self) -> None:
        payload = self._base_payload()
        payload["files"][0]["size_bytes"] = 2048
        request = parse_build_request(payload)
        assert request.files[0].size_bytes == 2048

    def test_size_bytes_defaults_to_none_when_absent(self) -> None:
        # The base payload omits size_bytes (legacy callers); it must parse as
        # None so the file streams inline rather than crashing.
        request = parse_build_request(self._base_payload())
        assert request.files[0].size_bytes is None

    @pytest.mark.parametrize("bad_size", [-1, "1024", 1.5, None])
    def test_invalid_size_bytes_coerced_to_none(self, bad_size: Any) -> None:
        # Lenient coercion: a malformed hint never rejects the build, it just
        # falls back to inline streaming.
        payload = self._base_payload()
        payload["files"][0]["size_bytes"] = bad_size
        request = parse_build_request(payload)
        assert request.files[0].size_bytes is None

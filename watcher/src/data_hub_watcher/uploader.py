"""Presigned-URL upload with retry, API notification, and local state recording.

`Uploader` handles auto-mode uploads (immediately after run detection) and
the server's upload queue, which `UploadQueueWorker` polls in both modes.

Files are uploaded via presigned S3 PUT URLs obtained from the API, so the
watcher does not need AWS credentials.
"""

from __future__ import annotations
import logging
import mimetypes
import re
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar, cast

import requests as http_requests
from requests.adapters import HTTPAdapter

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.constants import (
    MAX_PENDING_UPLOAD_ATTEMPTS,
    MAX_QUEUE_FILE_ATTEMPTS,
    UPLOAD_POLL_INTERVAL_SECONDS,
    UPLOAD_RETRY_BASE_DELAY,
    UPLOAD_RETRY_MAX,
)
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import (
    MultipartPartUrlsResponse,
    PresignedUploadResponse,
    UploadQueueFile,
)
from data_hub_watcher.run_detector import FileInfo, file_created_at
from data_hub_watcher.state import PendingUploadRecord, StateDB
from data_hub_watcher.util import file_digests

logger = logging.getLogger(__name__)

# Part URLs expire with the signing credentials, so fetch a few at a time.
# Eight is the most the server returns in one call.
_PART_URL_BATCH = 8
# A URL fetched longer ago than this is fetched again before it is used.
_PART_URL_MAX_AGE_SECONDS = 300
# More tries than a whole-file upload. One short network drop must not
# cancel a multi-gigabyte file that is already mostly in S3.
_PART_ATTEMPTS = 6
_PART_BACKOFF_CAP_SECONDS = 30
# A worker waiting for an upload slot, or backing off before a retry, looks
# for a stop (or a failed sibling part) this often. A thread that waits for
# worker threads wakes this often too, because Python on Windows delivers
# Ctrl-C to a thread only between timed waits.
_WAIT_STEP_SECONDS = 0.5

_T = TypeVar("_T")
# What the shared iterator in `_run_workers` returns once it has no more items.
_NO_MORE = object()


class _UploadStopped(Exception):
    """The watcher was asked to stop while a part was in progress."""


class _FileSlice:
    """A file range with a known length, so `requests` sends Content-Length.

    S3 rejects a part that arrives with chunked transfer encoding.
    """

    def __init__(self, path: Path, start: int, length: int) -> None:
        self._handle = path.open("rb")
        self._handle.seek(start)
        self._left = length
        self._length = length

    def __len__(self) -> int:
        return self._length

    def read(self, size: int = -1) -> bytes:
        if self._left <= 0:
            return b""
        if size < 0 or size > self._left:
            size = self._left
        chunk = self._handle.read(size)
        self._left -= len(chunk)
        return chunk

    def close(self) -> None:
        self._handle.close()


class _UrlFetch:
    """One part-URL request, which later callers for the same URLs wait on."""

    def __init__(self) -> None:
        self.done = threading.Event()
        # Set before ``done``: the URLs the server returned, or what went wrong.
        self.urls: dict[int, str] = {}
        self.error: BaseException | None = None


class _PartUrls:
    """Part upload URLs for one multipart upload, shared by its part workers.

    A part that has no URL yet fetches its whole batch: parts 1-8, then 9-16,
    and so on in steps of ``_PART_URL_BATCH``. Its neighbours are then ready.
    A retry of a part that has a URL, or a cached URL older than
    ``_PART_URL_MAX_AGE_SECONDS``, fetches only that part.

    The lock is held only to look at the cache and the requests in flight,
    never across a request. A fresh cached URL is therefore returned at once,
    even while another worker's request is slow. Workers that miss on the same
    URLs together share one request, and a failure of that request is raised
    to each of them.
    """

    def __init__(
        self,
        fetch: Callable[[list[int]], MultipartPartUrlsResponse],
        part_count: int,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fetch = fetch
        self._part_count = part_count
        self._clock = clock
        self._lock = threading.Lock()
        # Part number -> (URL, when it was fetched).
        self._cache: dict[int, tuple[str, float]] = {}
        # The part numbers of each request in flight -> that request.
        self._in_flight: dict[tuple[int, ...], _UrlFetch] = {}

    def get(self, part_number: int, *, refresh: bool = False) -> str:
        with self._lock:
            cached = self._cache.get(part_number)
            if cached is not None and not refresh:
                url, fetched_at = cached
                if self._clock() - fetched_at < _PART_URL_MAX_AGE_SECONDS:
                    return url
            if cached is None:
                first = (part_number - 1) // _PART_URL_BATCH * _PART_URL_BATCH + 1
                last = min(first + _PART_URL_BATCH, self._part_count + 1)
                numbers = tuple(range(first, last))
            else:
                numbers = (part_number,)
            request = self._in_flight.get(numbers)
            leader = request is None
            if request is None:
                request = self._in_flight[numbers] = _UrlFetch()

        if leader:
            self._fetch_and_store(numbers, request)
        else:
            request.done.wait()
        if request.error is not None:
            raise request.error
        if part_number not in request.urls:
            raise RuntimeError(f"the server returned no URL for part {part_number}")
        return request.urls[part_number]

    def _fetch_and_store(self, numbers: tuple[int, ...], request: _UrlFetch) -> None:
        """Make the request, cache what came back, and wake the workers waiting on it."""
        try:
            response = self._fetch(list(numbers))
            request.urls = {part.part_number: part.upload_url for part in response.parts}
            now = self._clock()
            with self._lock:
                for number, url in request.urls.items():
                    self._cache[number] = (url, now)
        except BaseException as exc:
            request.error = exc
        finally:
            # Clear the request on an error too, so the next attempt asks again.
            with self._lock:
                del self._in_flight[numbers]
            request.done.set()


class _PartRun:
    """Which parts of one multipart upload have finished, and the first failure.

    The first real failure sets ``cancel``, so no part that has not started
    will start.
    """

    def __init__(self, part_count: int) -> None:
        self.cancel = threading.Event()
        self.error: BaseException | None = None
        self._part_count = part_count
        self._etags: dict[int, str] = {}
        self._lock = threading.Lock()

    def finish(self, part_number: int, etag: str) -> None:
        with self._lock:
            self._etags[part_number] = etag

    def fail(self, exc: BaseException) -> None:
        with self._lock:
            if self.error is None:
                self.error = exc
        self.cancel.set()

    @property
    def complete(self) -> bool:
        with self._lock:
            return len(self._etags) == self._part_count

    def parts(self) -> list[dict[str, object]]:
        """The finished parts in part-number order, as the complete call expects them."""
        with self._lock:
            return [{"part_number": n, "etag": self._etags[n]} for n in sorted(self._etags)]


class _Transfer:
    """The span of one file's transfer to S3, for the ``file_uploaded`` event.

    It starts when the first upload slot is taken and ends when the file's
    bytes are in S3. Hashing and the wait for that first slot are left out;
    later waits for a slot, and backoff between attempts, count.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started: float | None = None
        self._finished: float | None = None

    def start(self) -> None:
        """Record the first call only. Later calls (other parts, a restart) keep it."""
        with self._lock:
            if self._started is None:
                self._started = time.monotonic()

    def finish(self) -> None:
        with self._lock:
            self._finished = time.monotonic()

    @property
    def seconds(self) -> float:
        with self._lock:
            if self._started is None or self._finished is None:
                return 0.0
            return self._finished - self._started


def _run_workers(
    items: Sequence[_T],
    task: Callable[[_T], None],
    *,
    workers: int,
    name: str,
    halted: Callable[[], bool],
    on_interrupt: Callable[[], None],
) -> None:
    """Run ``task(item)`` for every item, on up to *workers* threads at a time.

    The threads are daemon threads. Python joins ``ThreadPoolExecutor`` threads
    when the process exits, which would hold the exit until every send in
    flight ended. A daemon thread is dropped at exit instead, so a shutdown
    is bounded by the runtime's timed join of the upload worker, not by the
    sends in flight.

    The threads pull items, in order, from one iterator behind a lock, so each
    item runs once. No item starts after ``halted()`` turns true; items already
    running finish. With one worker, or one item, there is no thread: the items
    run on the calling thread, and a task's error is raised at once.
    Otherwise a task's error is kept, and the first one is raised after every
    thread has exited.

    The calling thread waits for the threads in short timed steps. A wait with
    no timeout cannot be interrupted by Ctrl-C on Windows. If the wait is
    interrupted, ``on_interrupt()`` runs, so the threads stop starting items,
    and the interrupt is raised again without waiting for them.
    """
    count = min(workers, len(items))
    if count <= 1:
        for item in items:
            if halted():
                return
            task(item)
        return

    pending = iter(items)
    lock = threading.Lock()
    errors: list[BaseException] = []

    def pull() -> None:
        while True:
            with lock:
                item = _NO_MORE if halted() else next(pending, _NO_MORE)
            if item is _NO_MORE:
                return
            try:
                task(cast(_T, item))
            except BaseException as exc:
                with lock:
                    errors.append(exc)

    threads = [
        threading.Thread(target=pull, name=f"{name}-{n}", daemon=True) for n in range(1, count + 1)
    ]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            while thread.is_alive():
                thread.join(_WAIT_STEP_SECONDS)
    except BaseException:
        on_interrupt()
        raise
    if errors:
        raise errors[0]


def _xml_tag(body: str, tag: str) -> str | None:
    match = re.search(rf"<{tag}>([^<]*)</{tag}>", body)
    return match.group(1) if match else None


# `requests` and `urllib3` put the full URL in their error text, and a signed
# S3 URL's query string holds temporary AWS credentials.
_SIGNED_QUERY = re.compile(r"\?[^\s'\")]*X-Amz-[^\s'\")]*", re.IGNORECASE)


def _redact_signed_urls(text: str) -> str:
    return _SIGNED_QUERY.sub("?<redacted>", text)


def s3_error_details(exc: BaseException) -> dict[str, str]:
    """Pull S3's error code and message out of an HTTP error body."""
    details = {"error": _redact_signed_urls(str(exc))}
    response = getattr(exc, "response", None)
    text = getattr(response, "text", "") if response is not None else ""
    if not text:
        return details
    code = _xml_tag(text, "Code")
    message = _xml_tag(text, "Message")
    if code:
        details["s3_code"] = code
    if message:
        details["s3_message"] = message
        details["error"] = f"{code}: {message}" if code else message
    return details


@dataclass
class _QueueAttempt:
    """Per-file bookkeeping for upload-queue retries.

    ``count`` is the number of consecutive queue polls that have failed
    to upload the file (missing on disk or upload error); ``reason`` is the
    most recent failure cause, surfaced in the give-up event.
    """

    count: int
    reason: str


def _guess_content_type(path: Path) -> str:
    # `mimetypes.guess_type` is case-sensitive on some platforms. Azure
    # Cielo writes reports as `.PDF`; without the lowercase, the PUT
    # stores `binary/octet-stream` and browsers download the file.
    lowered = path.with_suffix(path.suffix.lower())
    content_type, _ = mimetypes.guess_type(str(lowered))
    # Extensions with no MIME mapping (e.g. `.AZE`) still need a concrete
    # type so the S3 object and the file record don't end up with null.
    return content_type or "application/octet-stream"


def _resolve_within(watch_dir: Path, relative: str) -> Path | None:
    """Resolve *relative* under *watch_dir*, or ``None`` if it escapes.

    Defense-in-depth against path traversal in server-supplied queue paths:
    the server validates ``relative_path`` too, but the watcher must never
    read outside its watch directory even if a malicious or buggy
    server sends ``../`` or an absolute path. Containment is checked on the
    *resolved* paths, not the raw string, because ``..`` segments (and an
    absolute ``relative`` that discards ``watch_dir`` entirely) only collapse
    after resolution.
    """
    base = watch_dir.resolve()
    candidate = (base / relative).resolve()
    if candidate == base or base in candidate.parents:
        return candidate
    return None


def _relative_path(path: Path, watch_dir: Path) -> str:
    """Return *path* as a forward-slash relative to *watch_dir*.

    Falls back to the basename for paths outside the watch directory
    (e.g. one-shot `upload --file /abs/path`) so we never raise during
    upload recording.
    """
    try:
        return path.relative_to(watch_dir).as_posix()
    except ValueError:
        return path.name


class Uploader:
    """Uploads files via presigned S3 PUT URLs and notifies the Data Hub API.

    Parameters
    ----------
    client:
        API client for presigned URL requests and file status updates.
    state_db:
        Local SQLite DB for deduplication.
    event_reporter:
        For queuing upload events.
    counters:
        Heartbeat counters incremented on each upload.
    instrument_id:
        Instrument identifier for API calls.
    watcher_id:
        Watcher identity for queue polling.
    watch_directory:
        Root watch directory for resolving relative paths in queue mode.
    upload_parallelism:
        The most S3 PUTs this uploader runs at once, whole files and
        multipart parts together. It is one budget for every path:
        :meth:`upload_files`, the upload queue, pending-upload retries,
        and the parts of a single large file. Defaults to 1 (fully
        serial) so unit tests and call sites that don't pass an explicit
        value keep their previous behaviour. Production wiring (see
        ``runtime.build_runtime``) reads this from the per-instrument
        config.
    """

    def __init__(
        self,
        *,
        client: DataHubClient,
        state_db: StateDB,
        event_reporter: EventReporter,
        counters: WatcherCounters,
        instrument_id: str,
        watcher_id: str,
        watch_directory: Path,
        upload_parallelism: int = 1,
        stop_event: threading.Event | None = None,
    ) -> None:
        self._client = client
        self._state_db = state_db
        self._reporter = event_reporter
        self._counters = counters
        self._instrument_id = instrument_id
        self._watcher_id = watcher_id
        self._watch_dir = watch_directory
        if upload_parallelism < 1:
            raise ValueError(f"upload_parallelism must be >= 1, got {upload_parallelism}")
        self._parallelism = upload_parallelism
        # Set by the owning ``UploadQueueWorker`` on shutdown, and by the
        # one-shot ``upload`` command on Ctrl-C. Once set, no new file or part
        # starts and a retry backoff or wait for an upload slot ends early;
        # parts already sending finish. ``None`` when the caller never stops
        # the uploader (unit tests).
        self._stop_event = stop_event
        # Track consecutive upload-queue poll failures so the watcher
        # surfaces a ``kind=upload_queue_poll_failed`` event on the
        # 1st failure and every 10th repeat. The unthrottled case
        # would emit one event per poll during an outage, crowding out
        # other signals on the dashboard.
        # Mutated only from the upload worker thread, so
        # not under any explicit lock.
        self._consecutive_queue_poll_failures = 0
        # Per-file upload-queue attempt bookkeeping, keyed by server file id.
        # Bounds retries before giving up (see ``_process_queued_file``) and
        # doubles as the emit-once throttle for the missing-file error. Pruned
        # each poll, so a re-requested id starts fresh. ``poll_upload_queue``
        # replaces the dict before it starts the file tasks and returns only
        # after they finish, and each task touches only its own file id.
        self._queue_attempts: dict[int, _QueueAttempt] = {}
        # Single ``requests.Session`` shared across every S3 PUT
        # (parallel or serial). Keeps TLS connections alive between
        # presigned URLs that target the same S3 bucket -- avoids
        # paying the handshake cost on every file in a multi-file
        # run. ``requests`` does not promise that a ``Session`` is
        # thread-safe. The parts that are unsafe to share are the cookie
        # jar and adapters changed while threads run. S3 sets no
        # cookies and the adapters are mounted once below, before any
        # upload starts, so sharing it across upload threads is fine.
        self._s3_session = http_requests.Session()
        # Size the urllib3 pool to match ``upload_parallelism`` so we
        # never trip the "Connection pool is full, discarding
        # connection" warning that the default ``pool_maxsize=10``
        # produces once parallelism exceeds 10 -- which the model
        # explicitly allows (``ge=1, le=32``). Discarded connections
        # defeat the keep-alive optimisation this session exists for.
        # ``pool_connections`` controls the number of *host* pools;
        # presigned S3 PUTs typically hit a single bucket-host so one
        # is enough, but matching ``pool_maxsize`` is harmless and
        # leaves room for cross-bucket fan-out if a future config does
        # that. ``pool_block=False`` (the default) preserves the prior
        # behaviour of spinning up a transient connection if the pool
        # is momentarily exhausted instead of blocking the worker. The
        # upload slots below keep concurrent PUTs at or below the pool
        # size, so connections are reused rather than discarded.
        adapter = HTTPAdapter(
            pool_connections=upload_parallelism,
            pool_maxsize=upload_parallelism,
        )
        self._s3_session.mount("https://", adapter)
        self._s3_session.mount("http://", adapter)
        # Counter mutations from upload worker threads are protected
        # by the GIL on the underlying ``int`` increment, but use an
        # explicit lock anyway so we can later move to ``threading.
        # Lock``-free atomics or ``itertools.count`` without a behaviour
        # change. Cheap enough at the per-file cadence that the
        # serialisation cost is negligible.
        self._counters_lock = threading.Lock()
        # Files with an upload in progress, keyed by resolved path. The auto
        # path and the queue worker can reach the same file, and a second
        # multipart start makes the server abort the first one.
        self._in_flight: set[Path] = set()
        self._in_flight_changed = threading.Condition()
        # One slot per simultaneous S3 PUT, shared by every file and part this
        # uploader sends. A slot is held only while a PUT runs (and, for a
        # part, while its URL is fetched), never during a backoff or while
        # waiting on another lock or on worker threads, so waiting for a slot
        # cannot deadlock.
        self._put_slots = threading.BoundedSemaphore(upload_parallelism)

    # ------------------------------------------------------------------
    # Auto-mode: upload a batch of files for a reported run
    # ------------------------------------------------------------------

    def upload_files(self, run_id: str, files: list[FileInfo]) -> int:
        """Upload every file in *files* for the given *run_id*.

        Called by `RunDetector` immediately after a successful run report
        (auto mode only).  Returns the number of files successfully uploaded.

        When ``upload_parallelism > 1`` the per-file
        :meth:`_upload_single` calls run on short-lived daemon threads
        (see :func:`_run_workers`), and their PUTs share the
        ``upload_parallelism`` budget with every other upload. The
        threads are scoped to a single batch (created and ended per
        call) so idle worker threads don't outlive the run -- watcher
        hosts are long-lived and an always-on pool would just be
        holding socket FDs and Python frames around for nothing between
        runs.
        """
        if not files:
            # Avoid spinning up threads for a (rare) empty manifest;
            # also preserves the existing "succeeded == len(files)"
            # check below which would mark the run uploaded with
            # zero work.
            self._state_db.record_run_uploaded(run_id)
            return 0

        self._state_db.record_pending_uploads(
            run_id, [_relative_path(info.path, self._watch_dir) for info in files]
        )

        uploaded: list[Path] = []

        def upload(info: FileInfo) -> None:
            if self._upload_pending(info.path, run_id):
                uploaded.append(info.path)

        # With one worker, or one file, this is a plain loop on this thread.
        # A stop starts no further file. The files that did not start, and
        # one that a stop cut off, keep the ``pending_uploads`` row recorded
        # above, because only a success clears it, so the next start's
        # ``retry_pending_uploads`` uploads them.
        _run_workers(
            files,
            upload,
            workers=self._parallelism,
            name="uploader",
            halted=self._stop_requested,
            on_interrupt=self._request_stop,
        )
        succeeded = len(uploaded)

        if succeeded == len(files):
            self._state_db.record_run_uploaded(run_id)
        else:
            logger.warning(
                "Not marking run %s as uploaded: %d/%d files succeeded",
                run_id,
                succeeded,
                len(files),
            )

        return succeeded

    def _upload_pending(self, path: Path, run_id: str) -> bool:
        """Upload an auto-mode file and clear its `pending_uploads` row on success."""
        if not self._upload_single(path, run_id):
            return False
        self._state_db.clear_pending_upload(_relative_path(path, self._watch_dir))
        return True

    def retry_pending_uploads(self) -> None:
        """Retry auto-mode uploads that an earlier watcher process never finished.

        Runs once per start on the upload worker. Hydration treats every
        reported file as handled and the initial scan skips them, so
        without this a failed or interrupted upload is never tried again.
        Each start counts as one attempt, capped at
        ``MAX_PENDING_UPLOAD_ATTEMPTS``. Files run up to ``upload_parallelism``
        at a time, and the method returns once all of them are done.
        """
        self._for_each(self._state_db.pending_uploads(), self._retry_pending)

    def _retry_pending(self, pending: PendingUploadRecord) -> None:
        """Retry one pending upload and record the outcome."""
        # The path came from our own state DB, so it is not re-checked
        # for traversal the way server-supplied queue paths are.
        path = self._watch_dir / pending.relative_path
        if not path.is_file():
            logger.warning("Dropping pending upload for missing file: %s", pending.relative_path)
            self._state_db.clear_pending_upload(pending.relative_path)
            self._reporter.report_error(
                "pending_upload_missing",
                f"Stopped retrying {path.name}: the file is no longer on disk",
                relative_path=pending.relative_path,
                run_id=pending.run_id,
            )
            return
        try:
            uploaded = self._upload_pending(path, pending.run_id)
        except Exception:
            # Count it as a failed attempt. Otherwise the same file fails
            # first on every start and the files after it are never retried.
            logger.exception("Retrying upload of %s failed", pending.relative_path)
            uploaded = False
        if uploaded:
            return
        if self._stop_requested():
            # An interrupted upload is not a failed attempt.
            return
        attempts = self._state_db.bump_pending_upload_attempts(pending.relative_path)
        if attempts < MAX_PENDING_UPLOAD_ATTEMPTS:
            return
        self._state_db.clear_pending_upload(pending.relative_path)
        self._reporter.report_error(
            "upload_retries_exhausted",
            (
                f"Gave up uploading {path.name} after {attempts} watcher starts; "
                "request it from the run page to try again"
            ),
            relative_path=pending.relative_path,
            run_id=pending.run_id,
            attempts=attempts,
        )

    # ------------------------------------------------------------------
    # Upload queue (both modes)
    # ------------------------------------------------------------------

    def _stop_requested(self) -> bool:
        return self._stop_event is not None and self._stop_event.is_set()

    def _request_stop(self) -> None:
        """Set the stop event, if there is one, for a wait that Ctrl-C interrupted."""
        if self._stop_event is not None:
            self._stop_event.set()

    def _for_each(self, items: Sequence[_T], fn: Callable[[_T], None]) -> None:
        """Run *fn* on each item, at most ``upload_parallelism`` at a time.

        Returns when every item is done. With one worker, or one item, it is a
        plain loop on the calling thread. Otherwise the items run on daemon
        threads created for this call (see :func:`_run_workers`). No item
        starts once a stop is requested, and an unexpected error is logged so
        it cannot end the other items.
        """

        def run(item: _T) -> None:
            try:
                fn(item)
            except Exception:
                logger.exception("Upload task failed")

        _run_workers(
            items,
            run,
            workers=self._parallelism,
            name="uploader",
            halted=self._stop_requested,
            on_interrupt=self._request_stop,
        )

    def poll_upload_queue(self) -> None:
        """Fetch the upload queue and process each file.

        Driven by the ``UploadQueueWorker`` loop on its own thread,
        decoupled from the heartbeat so a slow upload can't starve the
        liveness signal.
        """
        try:
            queue = self._client.get_upload_queue(self._watcher_id)
        except ApiError as exc:
            logger.warning("Failed to fetch upload queue: %s", exc.message)
            # Route through the shared helper so every error increment
            # (whether emitted from the heartbeat thread here or from
            # an upload worker thread in ``_upload_single``) goes through
            # the same lock. Inconsistent locking would race the
            # heartbeat reader against parallel-upload writers and
            # surface as off-by-one error totals.
            self._bump_errors()
            self._consecutive_queue_poll_failures += 1
            # Emit on first failure, then every 10th, so a sustained
            # outage stays visible without flooding the queue.
            if (
                self._consecutive_queue_poll_failures == 1
                or self._consecutive_queue_poll_failures % 10 == 0
            ):
                self._reporter.report_error(
                    "upload_queue_poll_failed",
                    f"Failed to fetch upload queue: {exc.message}",
                    error=exc.message,
                    consecutive_failures=self._consecutive_queue_poll_failures,
                )
            return

        # Reset on any success -- the next failure starts a fresh
        # outage window so the throttled emissions are accurate.
        self._consecutive_queue_poll_failures = 0

        # Prune attempt records for files no longer pending (uploaded,
        # cancelled, or dismissed) so the dict tracks only the live queue
        # and a re-requested id starts a fresh attempt window.
        current_ids = {qf.id for qf in queue.files}
        self._queue_attempts = {
            fid: rec for fid, rec in self._queue_attempts.items() if fid in current_ids
        }

        if not queue.files:
            return

        logger.info("Upload queue has %d file(s)", len(queue.files))
        if self._stop_requested():
            logger.info("Stop requested; deferring %d queued file(s)", len(queue.files))
            return
        # Files run up to ``upload_parallelism`` at a time, and a file that
        # starts after a stop is skipped, so the worker's ``stop()`` can join
        # promptly instead of draining the whole queue; the remaining files
        # are picked up on the next start's poll. This returns only after
        # every file task has finished, so the next poll never overlaps them.
        self._for_each(queue.files, self._process_queued_file)

    def _process_queued_file(self, qf: UploadQueueFile) -> None:
        """Attempt one queued file, bounding retries across polls.

        Queue polling repeats on the worker's cadence, so a file that
        can't be uploaded -- missing on disk after a watch-directory change, or a
        persistent upload error -- would otherwise re-error forever. We cap
        attempts at ``MAX_QUEUE_FILE_ATTEMPTS`` and then cancel the request
        server-side (revert to ``detected``) so it leaves the queue. The
        "Queued file missing" error is emitted only on the first miss; the
        upload path emits its own per-attempt events via ``_upload_single``.
        """
        attempt = self._queue_attempts.get(qf.id)
        attempt_count = attempt.count if attempt else 0

        # Already exhausted: a prior poll's cancel may have failed, so keep
        # retrying the cancel until the file drops out of the queue.
        if attempt_count >= MAX_QUEUE_FILE_ATTEMPTS:
            self._cancel_queued_file(qf, attempt.reason if attempt else "unknown")
            return

        raw_relative = qf.relative_path or qf.filename
        local_path = _resolve_within(self._watch_dir, raw_relative)
        if local_path is None:
            # Path escapes the watch directory (traversal or absolute).
            # Cancel rather than retry -- a re-poll resolves identically.
            logger.error(
                "Rejected queued file with unsafe path: %r (file_id=%s)",
                raw_relative,
                qf.id,
            )
            self._reporter.queue_event(
                WatcherEvent(
                    event_type=EventType.ERROR,
                    message=f"Rejected unsafe upload path: {qf.filename}",
                    details={
                        "kind": "unsafe_upload_path",
                        "file_id": qf.id,
                        "relative_path": raw_relative,
                    },
                )
            )
            self._bump_errors()
            self._cancel_queued_file(qf, "unsafe_path")
            return

        if local_path.exists():
            ok = self._upload_single(local_path, qf.run_id)
            reason = "upload_failed"
        else:
            ok = False
            reason = "missing"
            # Throttle: surface the visible "missing" error only on the
            # first miss for this file; later misses are debug-only until
            # the give-up threshold cancels the request.
            if attempt_count == 0:
                logger.error("Queued file not found locally: %s", local_path)
                self._reporter.queue_event(
                    WatcherEvent(
                        event_type=EventType.ERROR,
                        message=f"Queued file missing: {qf.filename}",
                        details={
                            "kind": "queued_file_missing",
                            "file_id": qf.id,
                            "expected_path": str(local_path),
                        },
                    )
                )
                self._bump_errors()
            else:
                logger.debug("Queued file still missing (already reported): %s", local_path)

        if ok:
            self._queue_attempts.pop(qf.id, None)
            return

        attempt_count += 1
        self._queue_attempts[qf.id] = _QueueAttempt(count=attempt_count, reason=reason)
        if attempt_count >= MAX_QUEUE_FILE_ATTEMPTS:
            self._cancel_queued_file(qf, reason)

    def _cancel_queued_file(self, qf: UploadQueueFile, reason: str) -> None:
        """Cancel a persistently-failing queued file's upload request.

        Reverts the file to ``detected`` server-side so it leaves the upload
        queue. On API failure the attempt record is left in place so the next
        poll retries the cancel; the give-up event fires only on a successful
        cancel, so a retried cancel doesn't re-flood the log.
        """
        try:
            self._client.cancel_upload_request(qf.id)
        except ApiError as exc:
            logger.warning(
                "Failed to cancel upload request for %s (file_id=%s): %s",
                qf.filename,
                qf.id,
                exc.message,
            )
            self._bump_errors()
            return

        logger.warning(
            "Gave up on queued file after %d attempts: %s (reason=%s)",
            MAX_QUEUE_FILE_ATTEMPTS,
            qf.filename,
            reason,
        )
        self._reporter.report_error(
            "upload_request_cancelled",
            (
                f"Gave up uploading {qf.filename} after {MAX_QUEUE_FILE_ATTEMPTS} "
                "attempts; cancelled upload request"
            ),
            file_id=qf.id,
            attempts=MAX_QUEUE_FILE_ATTEMPTS,
            reason=reason,
        )

    # ------------------------------------------------------------------
    # Presigned PUT helper
    # ------------------------------------------------------------------

    def _put_to_presigned_url(self, url: str, path: Path, content_type: str | None) -> None:
        """HTTP PUT a file's bytes to a presigned S3 URL.

        Reuses ``self._s3_session`` so successive PUTs to the same S3
        bucket share TLS connections. Method (rather than static) so
        the parallel-upload path inherits the session without each
        call having to thread it through.
        """
        headers: dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = content_type

        with open(path, "rb") as fh:
            resp = self._s3_session.put(url, data=fh, headers=headers, timeout=300)
        resp.raise_for_status()

    # ------------------------------------------------------------------
    # Single-file upload with retry
    # ------------------------------------------------------------------

    def _bump_errors(self) -> None:
        """Increment the shared error counter under ``_counters_lock``.

        Centralised so the parallel upload threads
        never race the heartbeat thread reading these values for its
        per-tick payload.
        """
        with self._counters_lock:
            self._counters.errors += 1

    def _bump_files_uploaded(self) -> None:
        """Increment the shared success counter under ``_counters_lock``."""
        with self._counters_lock:
            self._counters.files_uploaded += 1

    def _backoff(self, attempt: int) -> None:
        self._wait(UPLOAD_RETRY_BASE_DELAY * (2**attempt))

    def _part_backoff(self, attempt: int, cancel: threading.Event) -> None:
        delay = min(UPLOAD_RETRY_BASE_DELAY * (2**attempt), _PART_BACKOFF_CAP_SECONDS)
        self._wait(delay, cancel)

    def _wait(self, delay: float, cancel: threading.Event | None = None) -> None:
        """Sleep for *delay* seconds. A stop ends the wait early, and so does *cancel* if given."""
        if cancel is None:
            self._sleep(delay)
            return
        remaining = delay
        while remaining > 0 and not self._halted(cancel):
            step = min(remaining, _WAIT_STEP_SECONDS)
            self._sleep(step)
            remaining -= step

    def _sleep(self, delay: float) -> None:
        if self._stop_event is not None:
            self._stop_event.wait(delay)
        else:
            time.sleep(delay)

    def _halted(self, cancel: threading.Event | None) -> bool:
        """Whether the watcher is stopping or the file's other parts were cancelled."""
        return self._stop_requested() or (cancel is not None and cancel.is_set())

    def _acquire_slot(self, cancel: threading.Event | None = None) -> bool:
        """Take one of the shared upload slots. Returns False if a stop or *cancel* came first.

        A free slot is granted at once. Callers check for a stop or cancel
        before they ask, so only a wait needs to look again.
        """
        if self._put_slots.acquire(blocking=False):
            return True
        while not self._put_slots.acquire(timeout=_WAIT_STEP_SECONDS):
            if self._halted(cancel):
                return False
        if self._halted(cancel):
            self._put_slots.release()
            return False
        return True

    @contextmanager
    def _slot(self, cancel: threading.Event | None, transfer: _Transfer) -> Iterator[bool]:
        """Hold an upload slot for the body. Yields whether one was taken.

        The first slot a file takes starts its *transfer* clock.
        """
        acquired = self._acquire_slot(cancel)
        if acquired:
            transfer.start()
        try:
            yield acquired
        finally:
            if acquired:
                self._put_slots.release()

    def _fail_upload(self, filename: str, s3_key: str, exc: BaseException) -> None:
        details = s3_error_details(exc)
        details["s3_key"] = s3_key
        logger.error("Upload failed for %s: %s", filename, details["error"])
        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.UPLOAD_FAILED,
                message=f"Upload failed: {filename}",
                details=details,
            )
        )
        self._bump_errors()

    def _upload_single_put(
        self,
        path: Path,
        presigned: PresignedUploadResponse,
        content_type: str | None,
        s3_key: str,
        transfer: _Transfer,
    ) -> bool:
        url = presigned.upload_url
        if not url:
            self._fail_upload(path.name, s3_key, RuntimeError("missing upload URL"))
            return False

        last_exc: BaseException | None = None
        for attempt in range(UPLOAD_RETRY_MAX):
            try:
                with self._slot(None, transfer) as acquired:
                    if not acquired:
                        logger.info("Stop requested mid-upload; deferring %s", path.name)
                        return False
                    self._put_to_presigned_url(url, path, content_type)
                return True
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "Upload attempt %d/%d failed for %s: %s",
                    attempt + 1,
                    UPLOAD_RETRY_MAX,
                    path.name,
                    s3_error_details(exc)["error"],
                )
                self._backoff(attempt)
            if self._stop_requested():
                logger.info("Stop requested mid-upload; deferring %s", path.name)
                return False
        self._fail_upload(path.name, s3_key, last_exc or RuntimeError("upload failed"))
        return False

    def _upload_multipart(
        self,
        path: Path,
        presigned: PresignedUploadResponse,
        crc64nvme: str,
        size_bytes: int,
        content_type: str | None,
        relative_path: str | None,
        run_id: str,
        transfer: _Transfer,
    ) -> bool:
        upload = presigned
        if not upload.upload_id or not upload.part_size or not upload.part_count:
            self._fail_upload(
                path.name,
                upload.s3_key,
                RuntimeError("incomplete multipart response"),
            )
            return False

        # One restart when S3 says the assembled file does not match. A second
        # mismatch is a real failure.
        for digest_attempt in range(2):
            if self._stop_requested():
                return False
            try:
                parts = self._put_parts(path, upload, size_bytes, transfer)
            except _UploadStopped:
                return False
            except Exception as exc:
                # ``_put_parts`` returns or raises only after every part worker
                # has exited, so no PUT is still in flight when the upload is
                # aborted. S3 says to abort only after the parts are done.
                self._abort_quietly(upload.file_id, upload.upload_id)
                self._fail_upload(path.name, upload.s3_key, exc)
                return False
            try:
                self._complete_with_retries(upload, parts, crc64nvme)
                return True
            except ApiError as exc:
                code = exc.detail.code if exc.detail else ""
                if code == "BadDigest" and digest_attempt == 0:
                    logger.warning("Checksum rejected for %s; starting the upload over", path.name)
                    self._abort_quietly(upload.file_id, upload.upload_id)
                    try:
                        stat = path.stat()
                        upload = self._client.request_upload_url(
                            self._instrument_id,
                            run_id,
                            path.name,
                            content_type=content_type,
                            size_bytes=size_bytes,
                            file_created_at_ts=file_created_at(stat),
                            relative_path=relative_path,
                        )
                    except ApiError as restart_exc:
                        self._fail_upload(path.name, upload.s3_key, restart_exc)
                        return False
                    if upload.upload_type != "multipart" or not upload.upload_id:
                        self._fail_upload(
                            path.name,
                            upload.s3_key,
                            RuntimeError("restart did not return a multipart upload"),
                        )
                        return False
                    continue
                self._abort_quietly(upload.file_id, upload.upload_id)
                self._fail_upload(path.name, upload.s3_key, exc)
                return False
        return False

    def _abort_quietly(self, file_id: int, upload_id: str) -> None:
        try:
            self._client.abort_multipart_upload(file_id, upload_id)
        except ApiError:
            logger.debug("Abort of upload %s failed", upload_id, exc_info=True)

    def _put_parts(
        self,
        path: Path,
        upload: PresignedUploadResponse,
        size_bytes: int,
        transfer: _Transfer,
    ) -> list[dict[str, object]]:
        """Upload every part of *path*, up to ``upload_parallelism`` at a time.

        Returns the finished parts in part-number order. Raises
        ``_UploadStopped`` when a stop left parts unsent, or the first part's
        error when a part failed for good. Parts that had not started are never
        started after a stop or a failure, and this returns or raises only
        after every part worker has exited. The exception is Ctrl-C, which
        cancels the parts and raises without waiting for the ones in flight.
        """
        upload_id, part_size, part_count = self._multipart_plan(upload)
        urls = _PartUrls(
            lambda numbers: self._client.get_part_urls(upload.file_id, upload_id, numbers),
            part_count,
        )
        run = _PartRun(part_count)

        def put_part(number: int) -> None:
            try:
                etag = self._put_one_part(
                    path, urls, number, part_size, size_bytes, run.cancel, transfer
                )
            except _UploadStopped:
                return
            except Exception as exc:
                run.fail(exc)
                return
            run.finish(number, etag)

        # Parts start in order, each by one worker, until a stop or a failed
        # part sets the halt. The call returns after every worker has exited.
        _run_workers(
            range(1, part_count + 1),
            put_part,
            workers=self._parallelism,
            name="upload-part",
            halted=lambda: self._halted(run.cancel),
            on_interrupt=run.cancel.set,
        )

        # A stop that arrives while the last parts are in flight still leaves
        # every part uploaded, so the file is finished rather than deferred.
        if run.complete:
            return run.parts()
        if self._stop_requested():
            raise _UploadStopped
        if run.error is not None:
            raise run.error
        raise RuntimeError("upload ended before every part finished")

    def _multipart_plan(self, upload: PresignedUploadResponse) -> tuple[str, int, int]:
        if not upload.upload_id or not upload.part_size or not upload.part_count:
            raise RuntimeError("incomplete multipart response")
        return upload.upload_id, upload.part_size, upload.part_count

    def _put_one_part(
        self,
        path: Path,
        urls: _PartUrls,
        part_number: int,
        part_size: int,
        size_bytes: int,
        cancel: threading.Event,
        transfer: _Transfer,
    ) -> str:
        """Upload one part and return its ETag.

        Raises ``_UploadStopped`` when the watcher stops, or *cancel* is set,
        before an attempt starts. Otherwise it raises the last error once the
        attempts run out. A failed part-URL request counts as an attempt,
        except a 4xx, which fails the part at once.
        """
        start = (part_number - 1) * part_size
        length = min(part_size, size_bytes - start)
        last_exc: BaseException | None = None
        for attempt in range(_PART_ATTEMPTS):
            if attempt > 0:
                self._part_backoff(attempt - 1, cancel)
            if self._halted(cancel):
                raise _UploadStopped
            slice_reader: _FileSlice | None = None
            try:
                # The slot is held from the URL request through the PUT, so a
                # URL never waits in line and expires. Refresh on every retry,
                # not only when the error body says the URL expired. A
                # connection reset mid-body has no body to read, and the URL
                # may have expired while that body was in flight.
                with self._slot(cancel, transfer) as acquired:
                    if not acquired:
                        raise _UploadStopped
                    url = urls.get(part_number, refresh=attempt > 0)
                    slice_reader = _FileSlice(path, start, length)
                    response = self._s3_session.put(
                        url,
                        data=slice_reader,
                        headers={"Content-Length": str(length)},
                        timeout=300,
                    )
                    response.raise_for_status()
                    etag = response.headers.get("ETag") or response.headers.get("etag")
                    if not etag:
                        raise RuntimeError(f"part {part_number} response had no ETag")
                    return etag
            except _UploadStopped:
                raise
            except Exception as exc:
                if isinstance(exc, ApiError) and not exc.is_transient:
                    raise
                last_exc = exc
                logger.warning(
                    "Part %d attempt %d/%d failed for %s: %s",
                    part_number,
                    attempt + 1,
                    _PART_ATTEMPTS,
                    path.name,
                    s3_error_details(exc)["error"],
                )
            finally:
                if slice_reader is not None:
                    slice_reader.close()
        raise last_exc or RuntimeError(f"part {part_number} failed")

    def _complete_with_retries(
        self,
        upload: PresignedUploadResponse,
        parts: list[dict[str, object]],
        crc64nvme: str,
    ) -> None:
        upload_id, _part_size, _part_count = self._multipart_plan(upload)
        last_exc: ApiError | None = None
        for attempt in range(UPLOAD_RETRY_MAX):
            try:
                self._client.complete_multipart_upload(upload.file_id, upload_id, parts, crc64nvme)
                return
            except ApiError as exc:
                last_exc = exc
                if not exc.is_transient:
                    raise
                logger.warning(
                    "Complete attempt %d/%d failed: %s",
                    attempt + 1,
                    UPLOAD_RETRY_MAX,
                    exc.message,
                )
                self._backoff(attempt)
        if last_exc:
            raise last_exc

    @contextmanager
    def _exclusive(self, path: Path) -> Iterator[bool]:
        """Hold *path* for one upload. Yields whether another thread held it first."""
        key = path.resolve()
        waited = False
        with self._in_flight_changed:
            while key in self._in_flight:
                waited = True
                self._in_flight_changed.wait()
            self._in_flight.add(key)
        try:
            yield waited
        finally:
            with self._in_flight_changed:
                self._in_flight.discard(key)
                self._in_flight_changed.notify_all()

    def _upload_single(self, path: Path, run_id: str) -> bool:
        """Upload one file unless another thread is already uploading it.

        A caller that had to wait skips the upload when the other thread
        recorded it, which saves hashing a multi-gigabyte file again.
        Returns `True` on success, `False` after all retries exhausted.
        """
        with self._exclusive(path) as waited:
            if waited:
                if self._stop_requested():
                    return False
                st = path.stat()
                rel_path = _relative_path(path, self._watch_dir)
                if self._state_db.has_stat_match(rel_path, st.st_size, st.st_mtime):
                    return True
            return self._upload_single_unlocked(path, run_id)

    def _upload_single_unlocked(self, path: Path, run_id: str) -> bool:
        """Upload one file via a presigned URL, notify the API, and record in StateDB.

        Returns `True` on success, `False` after all retries exhausted. It
        also returns `False`, without recording a failure, when a stop came
        before the upload started.

        Concurrency note
        ----------------
        ``file_digests(path)`` and ``client.request_upload_url(...)``
        run on a tiny 2-thread pool so the (CPU+IO bound) hash and the
        (network bound) presigned-URL request fully overlap. On a
        multi-GiB instrument file with a slow API, this halves the
        critical-path latency before the actual S3 PUT can start. The
        pool is created per call -- short-lived overhead is dwarfed by
        the time savings on any non-trivial file.
        """
        content_type = _guess_content_type(path)
        stat = path.stat()
        rel_path = _relative_path(path, self._watch_dir)

        # Kick off both the SHA-256 and the presigned-URL request in
        # parallel. ``ThreadPoolExecutor(2)`` is plenty: hashing is
        # CPU/IO with mostly-released GIL via hashlib's C
        # implementation, and the request thread blocks on the
        # network. Resolve both before branching so the rest of the
        # method behaves exactly as the old serial version.
        prep_started = time.monotonic()
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="upload-prep") as prep:
            sha_future = prep.submit(file_digests, path)
            presign_future = prep.submit(
                self._client.request_upload_url,
                self._instrument_id,
                run_id,
                path.name,
                content_type=content_type,
                size_bytes=stat.st_size,
                file_created_at_ts=file_created_at(stat),
                relative_path=rel_path,
            )

            try:
                presigned = presign_future.result()
            except ApiError as exc:
                # Wait for the hash to finish (cancellation is best-effort
                # for already-running futures) before exiting the
                # ``with`` block, otherwise the pool blocks on shutdown.
                sha_future.cancel()
                try:
                    sha_future.result()
                except Exception:
                    pass
                logger.error("Failed to get presigned URL for %s: %s", path.name, exc.message)
                self._bump_errors()
                self._reporter.queue_event(
                    WatcherEvent(
                        event_type=EventType.UPLOAD_FAILED,
                        message=f"Presigned URL request failed: {path.name}",
                        details={"error": exc.message},
                    )
                )
                return False

            try:
                sha, crc64nvme = sha_future.result()
            except Exception as exc:
                # Hashing failed (e.g. the file vanished mid-stream).
                # Treat as an upload failure so the file is retried
                # rather than silently dropped.
                logger.error("Failed to hash %s: %s", path.name, exc)
                self._bump_errors()
                self._reporter.queue_event(
                    WatcherEvent(
                        event_type=EventType.UPLOAD_FAILED,
                        message=f"Hashing failed: {path.name}",
                        details={"error": str(exc)},
                    )
                )
                return False
            # The URL request finished above, so this is when both were done.
            prep_seconds = time.monotonic() - prep_started

        s3_key = presigned.s3_key
        s3_bucket = presigned.s3_bucket
        file_id = presigned.file_id

        if presigned.already_uploaded:
            logger.debug("Server says already uploaded, skipping: %s", path.name)
            self._state_db.record_upload(
                path.name,
                sha,
                s3_key,
                relative_path=rel_path,
                size_bytes=stat.st_size,
                mtime=stat.st_mtime,
            )
            return True

        if self._state_db.is_uploaded(path.name, sha, s3_key):
            logger.debug("Skipping already-uploaded file: %s", path.name)
            return True

        # A stop that came while the file was being hashed. Nothing has been
        # sent or recorded, and this is not an error: an auto-mode file keeps
        # its ``pending_uploads`` row and a queued file stays in the server's
        # queue, so the next start uploads it. Checking here, before any PUT,
        # is what lets ``_acquire_slot`` grant a free slot without looking.
        if self._stop_requested():
            logger.info("Stop requested; deferring %s", path.name)
            return False

        transfer = _Transfer()
        is_multipart = presigned.upload_type == "multipart"
        if is_multipart:
            if not self._upload_multipart(
                path,
                presigned,
                crc64nvme,
                stat.st_size,
                content_type,
                rel_path,
                run_id,
                transfer,
            ):
                return False
            transfer.finish()
        else:
            if not self._upload_single_put(path, presigned, content_type, s3_key, transfer):
                return False
            transfer.finish()
            # Notify API — treat a failed PATCH as an upload failure so the file
            # is not recorded in the dedup DB and will be retried next time. The
            # server derives the S3 location itself, so we only send status/type.
            # Multipart completion marks the file uploaded on the server.
            try:
                self._client.mark_file_uploaded(
                    file_id,
                    {
                        "content_type": content_type,
                        "status": "uploaded",
                    },
                )
            except ApiError as exc:
                logger.error("PATCH /files/%d failed: %s", file_id, exc.message)
                self._bump_errors()
                self._reporter.queue_event(
                    WatcherEvent(
                        event_type=EventType.UPLOAD_FAILED,
                        message=f"Upload notification failed: {path.name}",
                        details={"s3_key": s3_key, "file_id": file_id, "error": exc.message},
                    )
                )
                return False

        self._state_db.record_upload(
            path.name,
            sha,
            s3_key,
            relative_path=rel_path,
            size_bytes=stat.st_size,
            mtime=stat.st_mtime,
        )
        self._bump_files_uploaded()
        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.FILE_UPLOADED,
                message=f"Uploaded {path.name}",
                details={
                    "s3_key": s3_key,
                    "sha256": sha,
                    "size_bytes": stat.st_size,
                    # Hashing and the upload-URL request, which run together.
                    "prep_seconds": round(prep_seconds, 3),
                    # The transfer to S3: until the single PUT succeeds, or the
                    # multipart complete call returns. The file-status PATCH
                    # that follows a single PUT is not counted.
                    "upload_seconds": round(transfer.seconds, 3),
                    "part_count": (presigned.part_count or 1) if is_multipart else 1,
                },
            )
        )
        logger.info("Uploaded %s → s3://%s/%s", path.name, s3_bucket, s3_key)
        return True


class UploadQueueWorker:
    """Polls the server's upload queue on a dedicated long-lived thread.

    Uploads used to run on the heartbeat tick, so a slow or large transfer
    delayed heartbeats and the dashboard flagged a busy watcher as offline.
    Owning the poll loop here keeps the heartbeat free, and the shared
    ``stop_event`` lets a shutdown interrupt an upload so ``stop()`` can join
    before ``StateDB.close`` runs (which assumes writer threads have joined).

    With ``retry_pending_on_start`` (auto mode), the worker first retries
    uploads the previous process left unfinished.
    """

    def __init__(
        self,
        uploader: Uploader,
        *,
        stop_event: threading.Event,
        interval_seconds: int = UPLOAD_POLL_INTERVAL_SECONDS,
        retry_pending_on_start: bool = False,
    ) -> None:
        self._uploader = uploader
        self._stop_event = stop_event
        self._interval = interval_seconds
        self._retry_pending_on_start = retry_pending_on_start
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="upload-worker")
        self._thread.start()

    def stop(self, timeout: float | None = None) -> bool:
        """Signal the loop and join it. Returns whether the thread exited.

        A ``False`` return means an upload is still in flight past *timeout*
        (a single S3 PUT can run up to its request timeout); the caller uses
        this to avoid closing the state DB out from under the live upload.
        """
        self._stop_event.set()
        if self._thread is None:
            return True
        self._thread.join(timeout=timeout)
        return not self._thread.is_alive()

    def _run(self) -> None:
        if self._retry_pending_on_start:
            self._retry_pending_once()
        # Wait first (parity with the previous heartbeat-driven cadence),
        # then poll each interval until stop.
        while not self._stop_event.wait(timeout=self._interval):
            self._poll_once()

    def _retry_pending_once(self) -> None:
        try:
            self._uploader.retry_pending_uploads()
        except Exception:
            logger.exception("Retrying pending uploads failed")

    def _poll_once(self) -> None:
        # ``poll_upload_queue`` already handles and reports poll failures; this
        # guard only keeps an unexpected error from killing the thread and
        # silently ending all future polls.
        try:
            self._uploader.poll_upload_queue()
        except Exception:
            logger.exception("Upload queue poll failed")

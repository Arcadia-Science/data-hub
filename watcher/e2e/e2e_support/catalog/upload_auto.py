"""Auto mode: uploading each file right after its run is reported, and retrying after a crash.

Code: ``uploader.py`` (``Uploader.upload_files``, the single-PUT and multipart paths,
``retry_pending_uploads``), ``state.py`` (``pending_uploads``); server side
``request-upload-url``, ``files/[fileId]`` and ``files/[fileId]/multipart-upload``. The test
server's S3 stand-in uses 1 KB as both the multipart threshold and the part size.

The end-to-end boundary: a file is done when its row says ``uploaded`` and its bytes match in
the S3 stand-in.

What the watcher retries inside an upload: a whole-file PUT (three attempts, with a backoff), a
part (six attempts), and the request that completes a multipart upload (three attempts, for a 5xx
or no answer at all, but not for a 4xx). The upload-URL request is not retried inside the upload:
the file is left for the next start.
"""

from __future__ import annotations

from e2e_support.catalog.model import Transition, covered, excluded, xfail_bug

MACHINE = "upload_auto"

TRANSITIONS: tuple[Transition, ...] = (
    covered(
        MACHINE,
        "upload.stable->single_put_uploaded",
        "A file under 1 KB is uploaded with one presigned PUT: its row becomes `uploaded` "
        "with its S3 key, the stand-in holds identical bytes, and a `file_uploaded` event "
        "with one part follows.",
    ),
    covered(
        MACHINE,
        "upload.stable->multipart_uploaded",
        "A file of 1 KB or more is uploaded in parts and completed with a checksum: its row "
        "becomes `uploaded`, the stand-in holds identical bytes, and `file_uploaded` reports "
        "the part count.",
    ),
    covered(
        MACHINE,
        "upload.empty_file->uploaded",
        "A file of zero bytes is uploaded with one presigned PUT that carries `Content-Length: "
        "0` and no chunked transfer encoding (S3 refuses that): its row becomes `uploaded`, the "
        "stand-in holds an empty object, and `file_uploaded` reports zero bytes and one part.",
    ),
    covered(
        MACHINE,
        "upload.batch->parallel_within_budget",
        "Files are uploaded one at a time as they become stable, but when several of a run "
        "are waiting at once (the run update that reports them failed earlier) they upload "
        "at the same time (PUTs to different objects overlap), never more PUTs at once than "
        "`upload_parallelism` (whole files and parts together), and every file ends "
        "`uploaded`.",
    ),
    covered(
        MACHINE,
        "upload.pending->recorded_then_cleared",
        "The watcher records a `pending_uploads` row before the first PUT and removes it "
        "once the file is uploaded.",
    ),
    covered(
        MACHINE,
        "upload.put->retried_then_succeeds",
        "A single PUT that fails once or twice with a 5xx is retried with a 1 s and then "
        "2 s backoff and succeeds, without an `upload_failed` event.",
    ),
    covered(
        MACHINE,
        "upload.put->failed_after_retries",
        "A PUT that fails all three attempts queues `upload_failed` with the S3 key and the "
        "last error, counts an error in the heartbeat, and leaves the file `detected` with "
        "its `pending_uploads` row.",
    ),
    covered(
        MACHINE,
        "upload.presign->failed",
        "A failing upload-URL request queues `upload_failed` (`Presigned URL request "
        "failed`) and leaves the file `detected`.",
    ),
    covered(
        MACHINE,
        "upload.notify->failed",
        "When the request that marks the file uploaded fails after a good single PUT, the "
        "watcher queues `upload_failed` (`Upload notification failed`), records nothing as "
        "uploaded, and tries again at the next start.",
    ),
    covered(
        MACHINE,
        "upload.server->already_uploaded",
        "When the server already holds the file as uploaded (the mark-uploaded reply was "
        "lost), the retry's upload-URL request answers `already_uploaded` and the watcher "
        "records the file without another PUT.",
    ),
    covered(
        MACHINE,
        "upload.part->retried_then_succeeds",
        "A part of a multipart upload that fails is retried on its own, and the upload "
        "still completes.",
    ),
    covered(
        MACHINE,
        "upload.complete->retried_after_5xx",
        "A request that completes a multipart upload and gets a 5xx is retried with a 1 s "
        "backoff, without sending the parts again and without aborting, and the upload ends "
        "`uploaded` with no `upload_failed` event.",
    ),
    covered(
        MACHINE,
        "upload.complete->retried_after_lost_reply",
        "When the server completes a multipart upload but its reply never reaches the watcher, "
        "the retried request is answered `already_uploaded`, and the watcher counts that as a "
        "success: no `upload_failed` event and no abort of the finished upload.",
    ),
    covered(
        MACHINE,
        "upload.multipart->aborted_on_failure",
        "A part that fails for good aborts the multipart upload on the server, queues "
        "`upload_failed`, and leaves the file `detected`.",
    ),
    covered(
        MACHINE,
        "upload.multipart->bad_digest_restarted",
        "When the server rejects the assembled file's checksum because the file changed "
        "after it was hashed, the upload starts over once with a new multipart upload. The "
        "restart sends the first hash and size again, so it succeeds only if the file's bytes "
        "are the original ones once more.",
    ),
    covered(
        MACHINE,
        "upload.multipart->bad_digest_twice_failed",
        "A second checksum rejection is a real failure: the multipart upload is aborted "
        "and `upload_failed` is queued. (The file changes again during the restart, so the "
        "scenario holds whatever the restart hashes.)",
    ),
    xfail_bug(
        MACHINE,
        "upload.multipart->bad_digest_rehashed",
        "PROPOSED, confirm the intent: the restart after a rejected checksum hashes the file "
        "again and uploads its current bytes, so a file that changed while it was uploaded "
        "ends `uploaded` with its current bytes and `file_uploaded` carries their `sha256`. "
        "Today the restart reuses the first hash, so a file that stays changed fails the "
        "second attempt too.",
        "ENG-2122",
    ),
    covered(
        MACHINE,
        "upload.killed->pending_kept",
        "Killing the watcher in the middle of an upload leaves the file `detected` on the "
        "server and its `pending_uploads` row in the state database.",
    ),
    covered(
        MACHINE,
        "upload.pending->retried_on_start",
        "The next start retries every `pending_uploads` row once on the upload worker: the "
        "file ends `uploaded` and its row is removed.",
    ),
    covered(
        MACHINE,
        "upload.pending->attempts_exhausted",
        "A pending upload whose retry fails at three starts in a row (the start that left it "
        "pending doesn't count) is dropped with an `upload_retries_exhausted` event "
        "(`attempts` 3), and can still be requested from the run page.",
    ),
    covered(
        MACHINE,
        "upload.pending->file_missing",
        "A pending upload whose file is gone at start is dropped with a "
        "`pending_upload_missing` event.",
    ),
    xfail_bug(
        MACHINE,
        "upload.crash_after_report->retried_after_restart",
        "A watcher killed after its run report but before the `pending_uploads` row is "
        "written still uploads those files after a restart in auto mode.",
        "ENG-2111",
    ),
    # The same bug, reached without a crash: the run is reported and remembered in one
    # transaction and the pending record is written in another, so any interruption between them
    # (a kill, or a write that fails) leaves a reported file that nothing will upload. One fix
    # (write both together, or the pending record first) makes both scenarios pass, which is why
    # they share the slug.
    xfail_bug(
        MACHINE,
        "upload.pending_record_failed->retried_after_restart",
        "When the `pending_uploads` row of a reported run can't be written (the write fails, "
        "nothing crashes), the files are still uploaded after the next start in auto mode.",
        "ENG-2111",
    ),
    excluded(
        MACHINE,
        "file.uploaded->processed",
        "After `uploaded`, Lambda processes the file and it becomes `processing` and then "
        "`completed` or `failed`.",
        "The end-to-end boundary is the watcher and the server endpoints it calls: a file is "
        "done at `uploaded` with its bytes in the S3 stand-in. Lambda is tested by "
        "lambda/tests.",
    ),
)

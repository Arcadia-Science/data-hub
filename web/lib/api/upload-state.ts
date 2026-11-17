// Column resets for the upload transitions of a file, shared by every write
// that makes them so each clears the same columns. The checks on `files`
// (`files_upload_failure_matches_status`, `files_auto_upload_mark_before_upload`
// and `files_upload_requester_has_request`) reject a write that forgets one.

// The file is no longer `upload_failed`: requested again, or its bytes
// arrived. A pre-upload file has no processing error, so `error_message` only
// ever holds the failure reason here.
export const UPLOAD_FAILURE_RESET = {
  errorMessage: null,
  uploadFailedAt: null,
  uploadFailureReason: null,
} as const;

// The file's bytes reached S3: it is no longer waiting for an auto upload, and
// a reason it failed earlier no longer applies.
export const UPLOAD_ARRIVED_RESET = {
  ...UPLOAD_FAILURE_RESET,
  autoUploadExpectedAt: null,
} as const;

// An upload request was cancelled, or the watcher that was going to upload the
// file stopped being able to: the file goes back to `detected` and leaves the
// upload queue (which filters on `upload_requested_at`).
export const UPLOAD_REQUEST_CANCELLED_RESET = {
  autoUploadExpectedAt: null,
  uploadRequestedAt: null,
  uploadRequestedBy: null,
} as const;

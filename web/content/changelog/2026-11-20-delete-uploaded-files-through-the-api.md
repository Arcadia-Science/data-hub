---
title: The API and AI assistants can delete uploaded files
docs: https://datahub.arcadiascience.com/docs/mcp/tools
---

Deleting a file with `DELETE /api/v1/files/{fileId}` or the `dismiss_file` tool used to work only for a file that hadn't reached Data Hub storage yet. It now works for uploaded files too. The file stays in storage, and Data Hub records who deleted it: the signed-in person, or the token that made the request.

A file that is queued or processing can't be deleted until processing finishes, unless its processing has stalled. The request is refused with a message that says so. A file of a deleted run can't be deleted either. Deleting a file that is already deleted still succeeds.

A deleted file no longer appears in the files that `get_run`, `list_run_files` and the run details API return, and it no longer counts toward its run's status, file counts or size. You can still download it with its file ID.

When you reprocess a raw file, a preview image or video that was deleted earlier is saved again as an active file, so the new preview isn't left hidden. If a raw file whose processing stalled is deleted and the processing then finishes, the previews it made are saved deleted too, and processing stops without an error.

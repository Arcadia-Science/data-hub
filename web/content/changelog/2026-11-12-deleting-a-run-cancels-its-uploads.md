---
title: Deleting a run cancels its requested uploads
docs: https://datahub.arcadiascience.com/docs/browse-runs#reprocess-and-delete
---

When you deleted a run that still had uploads waiting for the watcher, those uploads stayed in the watcher's queue. Data Hub refuses uploads for a deleted run, so the watcher tried each file again and again and counted an error every time. It could never cancel them either, because Data Hub refused that too.

Now deleting a run cancels the uploads that were requested for its files. The files go back to **Pending**, and the watcher no longer sees them in its queue. Data Hub records an **Uploads Cancelled** event on the instrument's watcher, with the run and the number of files. You can filter the watcher's event log by this event type. It covers only cancellations caused by deleting a run. Other cancellations, such as a watcher stopping or a change of watch folder, still show under their own event types. Uploaded files and dismissed files aren't touched, and neither are the files of other runs.

Restoring a run doesn't bring the requests back. Choose **Upload** again for the files you still want.

Uploads that were already stuck in deleted runs are cancelled when this release's database update runs.

The dashboard's **Pending uploads** count, and the pending-upload count that `get_system_status` reports for each instrument, no longer include files from deleted runs.

This needs no new watcher version.

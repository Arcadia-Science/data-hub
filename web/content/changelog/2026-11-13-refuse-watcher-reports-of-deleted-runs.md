---
title: A watcher can no longer add files to a deleted run
docs: https://datahub.arcadiascience.com/docs/browse-runs#reprocess-and-delete
---

A watcher that had forgotten a run, for example after `state forget`, reported that run again. If an admin had deleted the run, Data Hub accepted the report and attached the new files to the deleted run.

Now Data Hub refuses that report with a conflict error and attaches none of its files. The watcher records a `run_report_failed` event with status 409 for each refused report. Restoring the run doesn't send those files by itself. The watcher sends them the next time it reports the run, when another file appears in the run's folder or the watcher restarts.

Only the watcher's reports are refused. Reports from Data Hub's own processing work as before.

This is a server-only fix, so you don't need to update the watcher.

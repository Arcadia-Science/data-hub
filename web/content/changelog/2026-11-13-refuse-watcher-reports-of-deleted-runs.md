---
title: A watcher can no longer add files to a deleted run
docs: https://datahub.arcadiascience.com/docs/troubleshoot-a-watcher#a-run-was-deleted-on-data-hub
---

A watcher that had forgotten a run, for example after `state forget`, reported that run again. If someone had deleted the run, Data Hub accepted the report and attached the new files to the deleted run.

Now Data Hub refuses that report with a conflict error and attaches none of its files. The error says the run was deleted on Data Hub and carries the reason `run_deleted`. Data Hub already refused updates to a deleted run. Those refusals now also say the run was deleted on Data Hub and carry the same reason.

Data Hub also refuses a report of a deleted run that carries files or an `acquired_at` time, whatever sends it. Its own file processing, which asks for a run by its ID alone, still gets the run back.

Restoring the run doesn't send the refused files by itself. Restart the watcher to send them, or choose **Upload** on a file from the run page to have the watcher send that file without a restart. Watchers before 1.4.3 also send them when another file of the run finishes. Watcher 1.4.3 and later record one event for the deleted run, instead of one for each file.

This is a server-side change, so you don't need to update the watcher to get it.

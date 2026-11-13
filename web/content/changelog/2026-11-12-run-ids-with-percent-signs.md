---
title: Run IDs with a percent sign now reach the right run
---

A run ID that contains a percent sign followed by two hex digits, such as `Q%41`, now reaches the right run in the app and in the API. Before, Data Hub read `Q%41` as `QA`. The run page, its comments and files, and every API call for that run went to a run called `QA`, or to no run.

Files in runs whose IDs contain `#`, `?`, or a percent sign followed by two hex digits, such as `Plate#3`, `a?b`, or `Q%41`, now also get processed. Before, the processing step sent those IDs to Data Hub without encoding them, so it asked for a different run and the files stayed unprocessed. For files that a watcher uploaded, choose **Reprocess** on the run. Files that were put straight into S3 never got a file row, so upload them again.

The watcher doesn't retry when Data Hub answers "not found", so a watcher file in such a run that failed before this fix needs a nudge. If the file shows as detected, choose **Upload** on the run page. A file that the watcher never reported goes out with the run's next file, or when the watcher restarts.

Nothing changes for run IDs that don't contain these characters.

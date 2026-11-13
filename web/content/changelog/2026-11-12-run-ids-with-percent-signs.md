---
title: Run IDs with a percent sign now reach the right run
---

A run ID that contains a percent sign followed by two hex digits, such as `Q%41`, now reaches the right run in the app and in the API. Before, Data Hub read `Q%41` as `QA`. The run page, its comments and files, and every API call for that run went to a run called `QA`, or to no run.

Files in runs whose IDs contain `#`, `?`, or a percent sign followed by two hex digits, such as `Plate#3`, `a?b`, or `Q%41`, now also get processed. Before, the processing step sent those IDs to Data Hub without encoding them, so it asked for a different run and the files stayed unprocessed. To process files that were skipped this way, choose **Reprocess** on the run.

Nothing changes for run IDs that don't contain these characters.

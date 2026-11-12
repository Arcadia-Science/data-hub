---
title: Reprocessing queues files, 10 at a time
docs: https://datahub.arcadiascience.com/docs/browse-runs#reprocess-queue
---

Reprocessing a large run used to start every file at once. That overloaded Data Hub, and other people's requests failed while it happened. Now reprocessing starts at most 10 files at a time, across all runs. The rest wait in a queue and start as slots free up, oldest first.

A file that is waiting shows **Queued** in the files table, and the **Status** filter on that table has a **Queued** option. A run with queued files shows **Queued** in the runs list and in the run status filter. While files are queued, the run page checks for updates every 5 seconds for up to 5 minutes. After that it stops, and **Refresh** checks for another 5 minutes.

The queue applies to every way of reprocessing: one file, selected files, a run, or several runs, from the web app, the REST API, or an AI assistant. The file reprocess endpoint and the `reprocess_file` tool now answer `queued` when the file has to wait, and `processing` when it starts at once. Reprocessing a file that is already queued returns a 409 error. If you select many files and choose **Reprocess**, the page now sends the requests a few at a time.

Some files that failed during that overload showed an empty error message. The message now names the problem, for example "Data Hub API returned HTTP 500 with no error message". Processing also retries each call it makes to Data Hub, including the call that saves a file's final status, when the call fails with a server error or a dropped connection. It tries up to four times, waits about 1, 2, and 4 seconds between tries (each wait a little longer by a random amount), and stops early when the processing time limit is close.

If the request that starts a file cannot be sent, or the processing service answers it with an error, the file shows **Failed** with a message that says so, and the next queued file starts. Choose **Reprocess** to try the file again. If the processing service is too busy to take a file, the file goes back to the queue.

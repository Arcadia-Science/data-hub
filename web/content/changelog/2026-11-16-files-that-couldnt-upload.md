---
title: Files the watcher couldn't upload now say so, and "Pending upload" is two statuses
docs: https://datahub.arcadiascience.com/docs/browse-runs#upload-failed
---

When the watcher gives up on a file, for example because its run folder was renamed on the instrument PC, the file now reads **Upload failed** instead of quietly going back to waiting. Hover over its status to see why: the folder is gone, the file is gone, the upload kept failing (with the last error), or the path is outside the watch folder. Choose **Upload** to try again once it's fixed, or **Dismiss** if the file is gone for good. A run with such a file reads **Upload failed** in the runs list, and the watcher's activity shows one **Couldn't upload** entry per run and reason, rather than two errors per file.

**Pending upload** is now two statuses. **Waiting to upload** means the files are on their way: someone requested them, or the watcher uploads them on its own. **Not uploaded** means nothing will upload them until someone asks, which is the usual state for files on instruments in manual upload mode. **Not uploaded** ranks below the processing statuses, so a run whose requested files are done no longer reads amber because of files nobody asked for. Saved links and API calls that filter by `pending` still work and match both.

Marking files **Upload failed**, and showing new files on auto-upload instruments as **Waiting to upload**, need watcher 1.4.5. An admin rolls out the new watcher by setting **Latest version** to 1.4.5 in **Settings → Watchers**. Until then, a file an older watcher gives up on goes back to **Not uploaded**.

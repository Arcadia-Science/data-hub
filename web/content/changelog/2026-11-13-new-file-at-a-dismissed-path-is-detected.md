---
title: A different file at the path of a dismissed file is now detected
docs: https://datahub.arcadiascience.com/docs/concepts#dismiss
---

Dismissing a file kept its path taken in that run. If a watcher later reported a different file at the same path, for example after the instrument wrote a new file there and the watcher's record of the folder was cleared, Data Hub dropped the report without an error. The new file never appeared, and on instruments that upload automatically its upload request was refused.

Data Hub now detects a file at that path as a new file when its size or creation time differs from the dismissed file's (the modification time, on a system that doesn't record creation time). The dismissed file stays dismissed. If the watcher reports the dismissed file itself again, it still isn't brought back.

This fix is on the server only. You don't need to update the watcher.

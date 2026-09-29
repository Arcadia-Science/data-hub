---
title: Request upload works on every instrument with watcher 1.2.1
docs: https://datahub.arcadiascience.com/docs/watcher-releases
---

With watcher 1.2.1, **Request upload** works on instruments that upload files automatically. Before, a file you requested on one of those instruments showed **Uploading** but never uploaded.

Watcher 1.2.1 also retries an automatic upload that didn't finish, the next time the watcher starts. That covers a failed upload and one cut off by a restart or an update. It tries on up to three starts. After that, use **Request upload** on the run page to try again.

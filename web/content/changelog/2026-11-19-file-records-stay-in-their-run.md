---
title: A file record can only point at its own run's folder
docs: https://datahub.arcadiascience.com/docs/security#token-scopes
---

File processing registers each file it finds or makes by telling Data Hub where the file is in S3. Data Hub stored whatever location it was given, and a download link for that file then opened whatever was stored there. So a token allowed to register files could add one to a run it could change, point it at another instrument's file, and download that file through it.

Now Data Hub only stores a file's own location: the run's folder, under the file's name, in the bucket for raw data or for processed results, whichever matches the file. A request that names any other location gets `400 Bad Request`, and nothing is stored.

This is a server-side change, so you don't need to update the watcher.

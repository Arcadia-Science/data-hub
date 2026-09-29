---
title: Files with an unrecognized extension upload correctly
docs: https://datahub.arcadiascience.com/docs/api/files/updateFile
---

Files with no standard type, such as `.AZE`, used to fail after they reached storage. Those files also lost their recorded size. The API now accepts `content_type: null` when updating a file and keeps the size and type it already has. This works with every watcher version.

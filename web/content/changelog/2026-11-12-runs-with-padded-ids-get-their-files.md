---
title: Runs whose ID starts or ends with a space now get all their files
docs: https://datahub.arcadiascience.com/docs/concepts#run
---

A run ID can start or end with a space, for example when the run folder is named ` RUN1`, or when a file pattern picks `RUN1 ` out of `RUN1 _a.csv`. Data Hub created that run as `RUN1`, but could not find it when the watcher sent the ID with the space. The watcher's run updates and upload requests failed. On instruments set to upload automatically, none of the run's files uploaded, and files added later never reached the run.

Data Hub now ignores spaces at the start or end of a run ID in API requests, MCP tools, and links to a run page, so the run is found and all its files upload. Spaces inside an ID still count, so `run 1` and `run1` stay different runs.

This fix is on the server only. You don't need to update the watcher.

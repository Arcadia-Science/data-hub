---
title: Files larger than 5 GB upload with watcher 1.2.0
docs: https://datahub.arcadiascience.com/docs/watcher-releases
---

Watcher 1.2.0 sends files of 100 MB or more in smaller parts, so files larger than 5 GB now reach Data Hub. Older watchers still can't upload files that large.

Some DishCam and Hina Microscope files are too large to process. Those files now show **Failed** with a message that gives the file size. The raw file is still stored, and you can download it.

An admin rolls out the new watcher by setting **Latest version** to 1.2.0 in **Settings → Watchers**. Watchers then upgrade themselves.

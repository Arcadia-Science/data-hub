---
title: Files with the same name from different folders stay in one run
docs: https://datahub.arcadiascience.com/docs/cli-reference
---

When a run gathers files from several folders, two files can share a name. Data Hub used to keep only the first one. With watcher 1.1.0, Data Hub keeps both and adds a short tag to the later name, such as `sample~3f9a1c2b.tif`. DishCam also pairs each photo stack with the `run.json` from its own folder.

To upload files that an older watcher skipped, update it to 1.1.0 and stop it. Then run `data-hub-watcher state forget --prefix your_folder_name/` on the instrument PC and start the watcher again.

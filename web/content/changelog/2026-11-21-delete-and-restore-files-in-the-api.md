---
title: The API and AI assistants can delete and restore several files at once
docs: https://datahub.arcadiascience.com/docs/api#deleted-files
---

New API endpoints delete and restore up to 100 files of a run at once, with a result for each file. With `include_linked`, they also take along the files linked to a raw file, such as its previews and its capture's `run.json`. Run details list deleted files when you pass `include_deleted=true`. The `files:delete` token scope now covers restoring too.

AI assistants get `delete_files` and `restore_files`, and `get_file` still finds a deleted file. `dismiss_file` will be removed, so use `delete_files` instead.

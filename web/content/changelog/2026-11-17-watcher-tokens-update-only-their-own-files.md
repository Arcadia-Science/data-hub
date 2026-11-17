---
title: A watcher's token can update only its own instrument's files
docs: https://datahub.arcadiascience.com/docs/security#how-tokens-act
---

Any token with the `files:update` scope could change the upload status of any file through `PATCH /api/v1/files/:id`. That included the token on each instrument PC, so one PC's token could, for example, mark another instrument's file uploaded or cancel its upload request.

Now a token that registered a watcher can update only the files of instruments whose current watcher it registered, and gets `403 Forbidden` for any other file. A token whose watchers were all deregistered can't update any file until it registers a watcher again. File processing uses a token that registered no watcher, so it still updates files on every instrument.

This is a server-side change, so you don't need to update the watcher to get it.

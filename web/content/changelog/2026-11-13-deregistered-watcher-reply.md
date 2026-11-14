---
title: A watcher that was deregistered stops, and Data Hub now says why
docs: https://datahub.arcadiascience.com/docs/troubleshoot-a-watcher#the-watcher-was-deregistered
---

A watcher whose registration was deleted in Data Hub, by deregistering it or by retiring its instrument, used to keep running on the instrument PC and get an error on every request. Watcher 1.4.3 stops instead. After three heartbeats in a row get the answer that it was deregistered, about three minutes, it stops uploading and logs an error that says to run `data-hub-watcher init`. `data-hub-watcher watch` then exits with code 3, and the Windows service stops and is not restarted. Starting a deregistered watcher is refused with the same message. Older watchers keep running until someone stops them on the PC.

To make that possible, the heartbeat endpoint (`POST /api/v1/watchers/{id}/heartbeat`) and `GET /api/v1/watchers/{id}` now tell a deregistered watcher apart from a watcher ID that doesn't exist. Both are still HTTP 404. The error `code` is `WATCHER_DEREGISTERED` for a watcher that was deregistered and `NOT_FOUND` for an ID that doesn't exist, and watcher 1.4.3 stops only on `WATCHER_DEREGISTERED`. The heartbeat endpoint answers `WATCHER_DEREGISTERED` only to a token that may act for that watcher. Any other token gets `NOT_FOUND`.

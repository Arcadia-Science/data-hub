---
title: Each instrument has a watcher page, and its badge says whether new files will arrive
docs: https://datahub.arcadiascience.com/docs/manage-watchers#the-watcher-page
---

Everything about an instrument's watcher now lives on its own page, at **Instruments** → the instrument → **Watcher**. Select the status badge beside the instrument's name, or, as an admin, choose **Watcher** from the three-dot menu. The page has three tabs: **Activity**, the event log in plain words; **Health**, the last 7 days of heartbeats, uploads and restarts; and **Settings**, the form for changing the watcher's settings and the history of every change. Anyone signed in can read the page. Admins can also change settings, restore an earlier version, and deregister the watcher. The **Edit watcher config** dialog is gone, and an instrument that has had more than one watcher gets a switcher for the past ones.

The instrument page now says whether new files will arrive. Its badge reads **Online**, **Restarting**, **Connecting**, **Offline**, **Pending**, or **Retired**, and hovering over it explains what that means. A routine restart or automatic update shows **Restarting** instead of a red **Offline**. When the badge reads **Offline**, a notice says why, and admins get a button to fix it where one helps. The same badge appears in the instruments table, on Home, and in search.

On a run page, the **Upload** buttons follow the badge, and there is a new **Upload all** button. Files that were found but not uploaded now read **Waiting to upload**, not **Pending**. If the instrument is **Offline** and the run still has files on the instrument PC, a notice says so.

For admins, **Settings → Watchers** now lists every watcher below the release form, with a pill that shows how many run the latest version. **Watchers** is no longer in the sidebar, and old links to it keep working. Confirming a pending instrument opens a review of what its watcher was set up to do, and asks you to choose an instrument type, in one step.

Instrument responses from the REST API (`GET /instruments` and `GET /instruments/:id`) and from the `list_instruments` and `get_instrument` tools now include `watcher`, `connection`, and a count of past watchers (`past_watcher_count` in REST, `pastWatcherCount` in MCP). The older fields are deprecated and still return the values they had: `watcherCount`, `watchersOnline`, `watchersOffline`, `hasDeregisteredWatcher`, `lastWatcherHeartbeatAt`, the `activeWatcher*` fields, the top-level `filePatterns`, and REST's `watcher_count`. Instrument results from `GET /search` and the `global_search` tool now include `connection` too, and their `watcherStatus` and `lastWatcherHeartbeatAt` are deprecated. The `get_system_status` tool's instrument summaries include `connection` as well, and their `watcherStatus` is deprecated. Move to the new fields before they are removed; a later entry will give the date.

In REST, the `watcher` object leaves out `hostname`, `os_info`, `version`, `watch_directory`, and `shared_computer_with` for a token that has `instruments:read` but not `watchers:read`, because those fields say where the watcher runs, and reading them has always needed `watchers:read`. The keys are missing, not `null`. Tokens with `watchers:read`, such as the Watcher preset, and signed-in sessions get them as before. Token scopes themselves are unchanged. The MCP tools already returned them to every signed-in user.

**Preview with recent files** in a watcher's settings now skips files from deleted runs.

You don't need to update the watcher. A watcher shows **Restarting** for a Windows restart from watcher 1.4.1 and for an automatic update from 1.4.2. Older watchers read **Offline** while they restart.

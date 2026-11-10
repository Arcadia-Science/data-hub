---
title: Admins can edit a watcher's config from Data Hub
docs: https://datahub.arcadiascience.com/docs/manage-watchers#change-a-watchers-config
---

Admins can now change a watcher's settings without visiting the instrument PC. Open the watcher's **Configuration** tab, or choose **Edit watcher config** on the instrument page, to change the watch folder, file patterns, run detection, upload mode, and upload timing. **Preview with recent files** shows which of the instrument's recent files the new settings match and the run ID each would get.

The watcher picks up a saved change within about a minute. It checks the change first, including that the new folder exists, and keeps its current settings if a check fails. The change then shows as rejected, with the reason. The **History** list records every change, from Data Hub or from the config file on the PC, and **Restore** saves an earlier version as a new change. The watcher list shows **Change pending** and **Change rejected** badges.

If a watcher's folder is missing when it starts, it now keeps running and shows **Waiting: folder not found** instead of stopping, so you can fix the folder from Data Hub.

This needs watcher 1.3.0. For older watchers the form is turned off. An admin rolls out the new watcher by setting **Latest version** to 1.3.0 in **Settings → Watchers**. Watchers then upgrade themselves.

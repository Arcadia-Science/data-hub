---
title: Requested uploads survive a restart of the instrument PC
docs: https://datahub.arcadiascience.com/docs/windows-service#when-the-pc-restarts-or-shuts-down
---

When an instrument PC restarts, the watcher's Windows service now stops cleanly. Before, a restart ended the watcher without a word: Data Hub never recorded a stop, and any events the watcher hadn't yet sent were lost.

Now the watcher sends a final heartbeat, so it shows as **Stopped**, and a `watcher_stopped` event that reads "Service stopped: Windows is shutting down", so you can tell a restart from a stop you asked for. Files that someone requested with **Upload** stay requested, and the watcher uploads them once the PC is back. If no heartbeat arrives for about 15 minutes, Data Hub cancels the requests. Stopping the service yourself still cancels them at once.

Windows gives the service about 10 seconds to stop at a restart. If a file is still uploading, or Data Hub can't be reached, the stop can be cut off, and the watcher ends without its final heartbeat, as before. With Windows Fast Startup on, which is the default, **Shut down** in the Start menu doesn't stop the service at all. **Restart** does.

This needs watcher 1.4.1. An admin rolls out the new watcher by setting **Latest version** to 1.4.1 in **Settings → Watchers**. Watchers then upgrade themselves.

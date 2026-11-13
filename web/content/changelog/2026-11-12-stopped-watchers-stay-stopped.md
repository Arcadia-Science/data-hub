---
title: A stopped watcher keeps showing Stopped
docs: https://datahub.arcadiascience.com/docs/concepts#watcher-status
---

A watcher that someone stopped used to show **Unresponsive** after 5 minutes, even though it had said it was stopping and could not send another heartbeat. Now it keeps showing **Stopped** until it starts again. **Unresponsive** is for a watcher that went quiet without saying so, such as a crash, a power cut, or a blocked network.

A watcher that stopped because Windows is restarting or shutting down (watcher 1.4.1 and later) is expected back. It shows **Stopped**, and it shows **Unresponsive** if it hasn't returned 15 minutes after its last heartbeat. Hover over the badge to see that time. A later watcher version is meant to do the same for a stop to install an update.

The watcher list in the REST API now agrees with the badge. A `status` filter returns the watchers that show that status. Before, `status=stopped` could return a watcher that showed `stale`, and one watcher could appear under both filters. A `status` the API doesn't know now gets a 400 error. For a watcher that stopped for a restart, `status_reason` in the API and in the `get_watcher` tool now holds `system_shutdown` (or `auto_update`).

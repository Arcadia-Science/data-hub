---
title: Watcher 1.2.2 retries a run report that fails to send
docs: https://datahub.arcadiascience.com/docs/troubleshoot-a-watcher#a-run-is-missing-after-a-connection-problem
---

Sometimes the watcher can't reach Data Hub at the moment it reports a new run. Before, a run that was a single file, or whose last file had just finished, stayed unreported until another file in the run finished or the watcher restarted. It didn't appear in Data Hub, and in automatic mode its file wasn't uploaded.

With watcher 1.2.2, the watcher tries again by itself: first after 5 seconds, then after longer waits of up to 5 minutes, for about an hour. If it still can't report the run, it records a `run_report_retries_exhausted` event. The next file in the run, or a restart, tries again.

An admin rolls out the new watcher by setting **Latest version** to 1.2.2 in **Settings → Watchers**. Watchers then upgrade themselves.

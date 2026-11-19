---
title: An instrument whose watcher never checks in turns Offline
docs: https://datahub.arcadiascience.com/docs/troubleshoot-a-watcher#instrument-shows-offline
---

An instrument used to read **Connecting** for as long as its new watcher hadn't checked in, even when the watcher service never started or the PC couldn't reach Data Hub. Now **Connecting** lasts 15 minutes after the watcher is set up, or after an admin confirms the instrument if that comes later. After that the badge turns **Offline**, and the notice on the instrument's page says **The watcher never checked in**, with what to check on the PC. Subscribers hear about it like any other outage, and the watcher's page shows **Unresponsive**.

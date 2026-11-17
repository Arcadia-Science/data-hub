---
title: The run page explains failed uploads, and Home counts runs needing attention
docs: https://datahub.arcadiascience.com/docs/browse-runs#upload-failed
---

A run with files that couldn't upload now shows a red notice above its files. The notice puts the files in one block per reason and folder, says why and when the watcher gave up, and offers **Upload again** and **Dismiss these files** for each block.

Whoever requested the files gets one notification per run and reason, in the bell and, if they connected Slack, as a direct message. Turn it off with **Uploads that failed** under **Settings → Notifications**.

On Home and **My runs**, the **Pending uploads** card is now **Runs needing attention**. It counts runs whose upload failed, whose processing failed, or whose processing stalled, of any age. Choose the card to list those runs. The date filter on Home also has an **All time** choice now.

Failed uploads are reported by watcher 1.4.5 and later. An admin rolls it out by setting **Latest version** to 1.4.5 in **Settings → Watchers**.

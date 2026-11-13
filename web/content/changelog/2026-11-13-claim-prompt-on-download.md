---
title: Data Hub asks whether you ran a run when you download from it
docs: https://datahub.arcadiascience.com/docs/browse-runs#claim-prompt
---

When you download a run archive or a file from a run nobody has claimed, Data Hub now asks whether you ran it. Choose **I ran this** to claim the run, or **Not me** so that browser doesn't ask about the run again. A bulk download from a runs list asks once about all the unclaimed runs in it.

AI assistants get the same hint. The `get_run_archive` and `get_file_download_url` tools now return `unclaimed`, and `get_file_download_url` also returns the file's `instrumentId` and `runId`, so the assistant can ask whether you ran the run and claim it with `claim_run`.

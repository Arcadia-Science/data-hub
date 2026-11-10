---
title: Hina Microscope timelapses play as videos
docs: https://datahub.arcadiascience.com/docs/instrument-preprocessing
---

A Hina Microscope file with more than one time point used to show only its first frame. Data Hub now also turns all of its frames into a video, and the run page plays it, with the first frame shown before you press play. Files with a single time point still show one image.

The video plays at the capture rate or at 10 frames per second, whichever is faster. Each channel keeps the contrast of the first frame for the whole video, so brightness doesn't flicker.

If the video can't be made, the file shows **Failed** with the reason, and its first-frame image stays on the run page.

Timelapse runs processed before this change are being reprocessed to add their videos. To get a video sooner, use **Reprocess** on the file or on the run.

---
title: Hina Microscope run badges come from the first file
docs: https://datahub.arcadiascience.com/docs/instrument-preprocessing
---

A Hina Microscope run's channel, size, and dimension badges now come from the first file to finish processing, as the docs describe. Each later file used to replace them, so a run that mixed timelapse and single-frame files showed the badges of whichever file finished last.

Runs processed before this change keep their current badges, and reprocessing doesn't change them.

Creating a run through the API now also returns the run's `metadata`. For a run that already exists, that's the metadata stored so far.

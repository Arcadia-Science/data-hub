---
title: Reprocessing a run skips files that Data Hub generated
---

**Reprocess** now resends only the original instrument files. Before, it also queued the videos, posters, and CSV files Data Hub had generated, and those files stayed in processing. Generated files no longer show a **Reprocess** button.

If the processor can’t read a file, the file now shows as failed, with the reason on its row.

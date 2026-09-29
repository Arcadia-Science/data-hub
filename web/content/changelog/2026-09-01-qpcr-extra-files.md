---
title: Reprocessing a qPCR run no longer fails its extra files
---

Azure Cielo writes extra CSV files and a PDF report next to the files Data Hub reads. Reprocessing used to mark those extras as failed, so the whole run looked failed. They now show as completed, and the melting curve and Cq Values files still process as before.

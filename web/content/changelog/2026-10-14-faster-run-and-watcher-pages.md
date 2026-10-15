---
title: Run pages and watcher pages load faster
---

Run pages no longer read and parse every processed CSV file unless the instrument is a plate reader, which is the only one that shows that data. Runs from other instruments that have processed CSV files open sooner.

The watcher page only loads its heartbeat history when you open the Status tab, so the Logs and Configuration tabs open sooner. The file preview window and the filter menus on the dashboard and instrument pages also load when you first open them instead of with the page.

A download that Data Hub is still building now checks for progress less often while the browser tab is in the background. It still starts on its own when the file is ready.

Those menus, the file preview, and the watcher chart also start loading when you point at or focus the control that opens them, so they appear sooner. If one of them fails to load, for example on a poor connection, you now see a short message with a **Reload Page** button, and the rest of the page keeps working. A page that fails to render now keeps the sidebar and header and offers **Try Again**.

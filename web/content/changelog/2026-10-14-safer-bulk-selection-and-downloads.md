---
title: Bulk selection clears when the list changes, and several files download as one zip
docs: https://datahub.arcadiascience.com/docs/browse-runs#bulk-actions
---

The runs you select for a bulk action now clear when you change the search, a filter, or the sort, so Delete and Reprocess can no longer reach runs that are hidden from view. Moving to another page of the same results keeps your selection. The files table on a run page follows the same rule.

Choosing **Download** with several files selected now gives you one zip instead of starting one browser download per file, which browsers often block after the first few. One selected file still downloads directly.

The bar's actions for selected files follow each file's current status, so they no longer go stale while the page refreshes. Starting an action on one file locks only that file's row instead of every row.

The instrument page's **Clear** button now also clears the "Ran by" filter. On the dashboard and member pages, a date range now counts as a filter, so **Clear** appears and an empty list says "No runs match your filters." Deleting or restoring a run, and requesting uploads, now work for run IDs that contain spaces or other special characters. **Download filtered** is hidden when no file matches the filter.

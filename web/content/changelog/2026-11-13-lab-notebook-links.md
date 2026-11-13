---
title: Runs can link to their lab notebook pages
docs: https://datahub.arcadiascience.com/docs/browse-runs#lab-notebook
---

A run page now has a **Lab notebooks** section between the run summary and its files. Choose **Add link** to paste the URL of the notebook page for the experiment, from Notion, Google Docs, or any other site, and give it a label if you like. A run can have several links, and each one shows who added it. Tick **I ran this run** to claim the run at the same time.

Runs tables have a **Lab Notebook** column. Filter it to **No link** to find runs that still need one. To link many runs at once, select them and choose **Add notebook link** in the action bar, or **Remove notebook link** to take a link off them.

Global search finds runs by a pasted notebook URL, even when your copy differs in `www.`, the part after `#`, or tracking parameters. Notion links match by page ID, so they still match after the page is renamed.

The REST API has new `notebook-links` endpoints and a `runs:link` token scope, and run responses include `notebook_links`. AI assistants get the `add_notebook_link`, `update_notebook_link`, and `remove_notebook_link` tools, and `get_run` and `search_runs` return each run's links.

---
title: Scripts and AI assistants can filter runs by lab notebook label
docs: https://datahub.arcadiascience.com/docs/browse-runs#lab-notebook
---

The REST API's run lists, `GET /instrument-runs` and `GET /instruments/:instrumentId/runs`, take two new filters. `notebook_link_name` lists the runs with a lab notebook link by exactly that name, and `notebook_link_search` lists the runs with a link whose name contains some text, ignoring case. A link's name is its label, or the name Data Hub works out from its URL when it has none.

AI assistants get the same filters as `notebookLinkName` and `notebookLinkSearch` on `search_runs`. The new `list_notebook_link_names` tool lists the link names with how many runs have each one, so an assistant can find the exact name to filter by.

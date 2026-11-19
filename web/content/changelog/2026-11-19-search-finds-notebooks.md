---
title: Search finds lab notebooks, and a pasted notebook link finds its notebook
docs: https://datahub.arcadiascience.com/docs/browse-runs#search
---

Global search has a **Notebooks** group and tab. A notebook matches on its name, its description, or its link, and shows how many runs it has. Pasting a notebook page's link finds that notebook, even when your copy of the link differs from the one saved, and opening it lists all of its runs. Before, a pasted link listed the notebook's runs one by one, at most 25 of them.

Runs no longer match through their notebooks, so a notebook's name no longer fills the **Runs** group with its runs.

For scripts, `GET /search` takes `scope=notebooks` and returns a `notebooks` group, and run results no longer have `matchedNotebook` or the `notebook_link` match reason. The `global_search` tool for AI assistants changes the same way.

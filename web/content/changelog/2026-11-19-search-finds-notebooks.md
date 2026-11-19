---
title: Search finds lab notebooks, including by a pasted link
docs: https://datahub.arcadiascience.com/docs/browse-runs#search
---

Global search has a **Lab Notebooks** group and tab. A lab notebook matches on its name, its description, or its link, and shows how many runs it has. Pasting a lab notebook page's link finds that lab notebook, even when your copy of the link differs from the one saved, and opening it lists all of its runs. Before, a pasted link listed the lab notebook's runs one by one, at most 25 of them.

Runs no longer match through their lab notebooks, so a lab notebook's name no longer fills the **Runs** group with its runs.

For scripts, `GET /search` takes `scope=lab_notebooks` and returns a `lab_notebooks` group, and run results no longer have `matchedNotebook` or the `notebook_link` match reason. The `global_search` tool for AI assistants changes the same way.

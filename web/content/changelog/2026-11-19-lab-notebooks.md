---
title: Each lab notebook page is now one notebook, shared by all its runs
docs: https://datahub.arcadiascience.com/docs/browse-runs#lab-notebook
---

A lab notebook in Data Hub is now its own record: one notebook page, with a name, an optional description and owner, and the runs in it from every instrument. Before, each run kept its own copy of a link with its own label. Existing links to the same page became one notebook, named after the label most of its runs used.

On a run page, **Add to notebook** finds a notebook by its name, or takes a pasted link. A link to a page that has no notebook yet creates one and asks for its name. The **Lab Notebook** column filters by notebook, and the action bar has **Add to notebook** and **Remove from notebook** for many runs at once.

The REST API has new `/notebooks` endpoints in place of the `notebook-links` endpoints. Run responses list `notebooks` instead of `notebook_links`, and the run lists filter with `has_notebook` and `notebook_id` instead of `has_notebook_link`, `notebook_link_name`, and `notebook_link_search`. The `runs:link` token scope is now `notebooks:write`, and tokens that had it keep working. AI assistants get notebook tools such as `list_notebooks`, `create_notebook`, and `add_runs_to_notebook` in place of the notebook link tools and `list_notebook_link_names`.

---
title: Each lab notebook page is now one lab notebook, shared by all its runs
docs: https://datahub.arcadiascience.com/docs/lab-notebooks
---

A lab notebook in Data Hub is now its own record: one lab notebook page, with a name, an optional description and owner, and the runs in it from every instrument. Before, each run kept its own copy of a link with its own label. Existing links to the same page became one lab notebook, named after the label most of its runs used.

On a run page, **Add to lab notebook** finds a lab notebook by its name, or takes a pasted link. A link to a page that has no lab notebook yet creates one and asks for its name. The **Lab Notebook** column filters by lab notebook, and the action bar has **Add to lab notebook** and **Remove from lab notebook** for many runs at once.

The REST API has new `/lab-notebooks` endpoints in place of the `notebook-links` endpoints. Run responses list `lab_notebooks` instead of `notebook_links`, and the run lists filter with `has_lab_notebook` and `lab_notebook_id` instead of `has_notebook_link`. The `runs:link` token scope is now `lab-notebooks:write`, and tokens that had it keep working. AI assistants get lab notebook tools such as `list_lab_notebooks`, `create_lab_notebook`, and `add_runs_to_lab_notebook` in place of `add_notebook_link`, `update_notebook_link`, and `remove_notebook_link`.

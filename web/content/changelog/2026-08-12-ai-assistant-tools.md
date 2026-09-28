---
title: AI assistants get clearer tools and structured results
docs: https://datahub.arcadiascience.com/docs/mcp/tools
---

AI assistants can now filter a run’s files by status, claim several runs at once, and look up valid search filters. Data Hub also tells them that date filters use Coordinated Universal Time (UTC) days. Those days can differ from the ones the web app shows.

Every tool now returns named fields as well as text. The `list_instruments`, `list_watchers`, `get_system_status`, and `list_run_attributors` tools return an object, such as `{ instruments: [...] }`, instead of a bare list. If a script reads their text as a list, read the named field instead.

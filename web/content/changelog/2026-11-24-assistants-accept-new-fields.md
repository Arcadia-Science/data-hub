---
title: AI assistants accept new fields after an update
docs: https://datahub.arcadiascience.com/docs/mcp#structured-content-error
---

When an update added a field or a new value, such as a new status, an AI assistant session that was already open could reject answers with "Structured content does not match the tool's output schema". Tool lists now allow fields and values the assistant doesn't know yet, so an update that only adds them no longer causes that error.

A session that connected before this release needs one reconnect: reconnect Data Hub in your client, or start a new session.

Renaming or removing a tool, parameter, or field can still break an open session, so the old one keeps working, marked deprecated, for at least 14 days after its replacement is live.

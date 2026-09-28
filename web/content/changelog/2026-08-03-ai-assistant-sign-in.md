---
title: AI assistants connect at a new address and sign in through your browser
docs: https://datahub.arcadiascience.com/docs/mcp
---

AI assistants such as Claude and Cursor connect to Data Hub through its Model Context Protocol (MCP) server. That server moved from `/api/v1/mcp` to `/mcp/v1`, and the old address redirects to the new one.

AI assistants now sign in with your Data Hub account in the browser. Personal access tokens no longer work for them, and the **MCP** preset is gone from the access token form. If your assistant used a token, remove Data Hub from it, add it again at `/mcp/v1`, and approve the sign-in.

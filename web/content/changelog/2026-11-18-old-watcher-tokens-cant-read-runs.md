---
title: An old watcher token can no longer read runs and files
docs: https://datahub.arcadiascience.com/docs/security#token-scopes
---

Tokens created before scopes were split up carry the wildcard `*` or a coarse scope such as `runs:write`. When one of those was the token on an instrument PC, it could list, search and download every instrument's runs and files, not just its own.

Now, on a token that has registered a watcher, those older scopes count only for what a watcher needs: the scopes in the **Watcher** preset. The watcher keeps reporting runs and uploading files, but its token can no longer read runs or files. The **Tokens** page shows these tokens' narrowed scopes.

If you also use that token for scripts or notebooks, create a separate **Read-only** token for them.

This is a server-side change, so you don't need to update the watcher.

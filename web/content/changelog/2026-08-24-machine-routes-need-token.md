---
title: Watcher and processing API routes accept only access tokens
docs: https://datahub.arcadiascience.com/docs/manage-tokens
---

API routes that watchers and the file processor call now reject browser sign-in and accept only a personal access token. These routes include watcher registration and heartbeats, upload links, file updates, run creation and updates, and instrument creation. The web app is unaffected. If a script calls these routes with a browser session, give it a personal access token instead.

---
title: Connect Data Hub to Linear in Settings
---

Workspace admins can now connect Data Hub to a Linear workspace from **Settings → Integrations**, in a new **Linear** card. Enter the client ID, client secret, and webhook signing secret from your Linear app. Data Hub stores the secrets encrypted and never shows them again after you save.

**Test connection** checks the credentials against Linear, including a new secret you have typed but not saved yet. If client credentials are turned off for the Linear app, the message tells you to turn them on in the app's settings in Linear.

Pick the Linear team, an optional project, and an optional label for each kind of feedback report: bug, feature request, and other. Labels can be team labels or workspace-wide labels. Only public teams are listed, because Data Hub signs in to Linear as the app, which can't see private teams. If you change the team and pick a project or labels from the new team in the same save, those choices are kept. Choices from the old team are cleared.

This only saves the connection. Feedback reports keep going to Data Hub until a later update turns on delivery to Linear.

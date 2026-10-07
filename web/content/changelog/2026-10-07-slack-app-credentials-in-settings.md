---
title: Save Slack app credentials in Settings
docs: https://datahub.arcadiascience.com/docs/configure-notifications
---

Workspace admins can now enter the Slack app credentials in **Settings → Integrations**, in a new **Slack app** card. It covers the bot token for direct messages, and the client ID, client secret, and allowed workspace ID for **Connect Slack**. Changing them no longer needs a redeploy.

A value saved here is used instead of the matching environment variable, and **Remove saved value** puts the variable back in charge. The bot token and client secret are stored encrypted, and Data Hub never shows them again after you save. Saving them needs `INTEGRATION_SECRETS_KEY` to be set on the server.

If a saved value can't be read, for example because `INTEGRATION_SECRETS_KEY` changed, the card says so. Data Hub keeps using the environment variable in the meantime. Check the key, or paste the value again and save.

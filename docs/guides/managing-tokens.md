# Managing tokens

Personal access tokens authenticate the watcher and other API clients with the Data Hub API. This guide covers creating, using, and revoking tokens.

## Creating a token

### In the web app

1. Sign in to the Data Hub web app.
2. Go to **Settings > Access Tokens**.
3. Click **Create Token**.
4. Enter a descriptive name (e.g., "FPLC watcher - Lab 201").
5. Optionally set an expiration date.
6. Click **Create**.

The plaintext token is displayed once — **copy it immediately**. It cannot be retrieved again. The token starts with `dhub_` followed by a 64-character hex string.

### Via the API

```sh
curl -X POST https://data-hub.arcadiascience.com/api/v1/tokens \
  -H "Cookie: <session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"name": "FPLC watcher", "expires_at": "2027-01-01T00:00:00Z"}'
```

The `expires_at` field is optional. If omitted, the token never expires.

The response includes the plaintext token in the `token` field — this is the only time it's returned.

## Using a token

### With the watcher

During `data-hub-watcher init`, paste the token when prompted for the API key. Alternatively, set it as an environment variable:

```sh
export DATA_HUB_API_KEY=dhub_abc123...
data-hub-watcher init
```

The watcher stores the API key in its environment configuration and uses it for all subsequent API calls.

### With an MCP client

Add Data Hub to your MCP client configuration. For example, in Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "data-hub": {
      "url": "https://data-hub.arcadiascience.com/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer dhub_abc123..."
      }
    }
  }
}
```

Or in Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "data-hub": {
      "url": "https://data-hub.arcadiascience.com/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer dhub_abc123..."
      }
    }
  }
}
```

See the [MCP server docs](../mcp.md) for the full list of tools, resources, prompts, and client-specific setup details.

### With the API directly

Pass the token in the `Authorization` header:

```sh
curl https://data-hub.arcadiascience.com/api/v1/instruments \
  -H "Authorization: Bearer dhub_abc123..."
```

## Viewing tokens

Go to **Settings > Access Tokens** in the web app. The table shows:

| Column | Description |
| --- | --- |
| **Name** | The label you gave the token |
| **Token** | The prefix only (e.g., `dhub_a1b2...`) — the full token is never stored |
| **Last used** | When the token was last used to authenticate an API request |
| **Expires** | Expiration date, or "Never" |
| **Created** | When the token was created |

## Revoking a token

### In the web app

1. Go to **Settings > Access Tokens**.
2. Click the delete button next to the token you want to revoke.
3. Confirm the deletion.

The token is immediately invalidated. Any watcher or client using it will start receiving `401 Unauthorized` errors.

### Via the API

```sh
curl -X DELETE https://data-hub.arcadiascience.com/api/v1/tokens/<token-id> \
  -H "Cookie: <session-cookie>"
```

## Security notes

- Tokens are hashed with SHA-256 before storage. The plaintext is never persisted.
- Each token is scoped to the user who created it.
- You can only delete your own tokens.
- Use descriptive names so you can identify which watcher or client each token belongs to.
- Set expiration dates for tokens used in temporary setups.
- Revoke tokens immediately when a watcher is decommissioned or a token may have been exposed.

## After revoking a token

If you revoke a token that a running watcher is using, the watcher will start failing on its next heartbeat or API call. To fix it:

1. Create a new token.
2. On the instrument PC, re-run the setup wizard:

   ```sh
   data-hub-watcher init
   ```

3. Enter the new token when prompted.
4. Restart the watcher:

   ```sh
   data-hub-watcher watch
   ```

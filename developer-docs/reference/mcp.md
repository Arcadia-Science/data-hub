# MCP server

The Data Hub MCP server exposes instruments, runs, files, and watcher data to AI clients — such as Claude Desktop and Cursor — through the [Model Context Protocol](https://modelcontextprotocol.io/). Clients can list instruments, search runs, fetch experimental results, generate download URLs, and re-trigger Lambda processing, all through a single Bearer-authenticated HTTP endpoint served by the web app.

The server lives at `/api/v1/mcp` on the same Next.js deployment that serves the [REST API](api.md) and uses the MCP Streamable HTTP transport.

## Authentication

The MCP server accepts **Bearer tokens only** — session cookies are not supported. Create a personal access token in the web app at **Settings > Access Tokens**, then pass it in the `Authorization: Bearer <token>` header when configuring your client.

See [Managing tokens](../guides/managing-tokens.md) for details on creating, using, and revoking tokens.

## Installation

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "data-hub": {
      "url": "https://datahub.example.com/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer dhub_abc123..."
      }
    }
  }
}
```

Restart Claude Desktop. The `data-hub` server should appear in the MCP panel and its tools become available in conversations.

### Cursor

Edit `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "data-hub": {
      "url": "https://datahub.example.com/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer dhub_abc123..."
      }
    }
  }
}
```

Reload Cursor. Tools are invoked via the agent automatically when relevant.

### Other clients

The endpoint follows the MCP Streamable HTTP spec, so any compliant client works. Configure it with:

- **URL**: `https://datahub.example.com/api/v1/mcp`
- **Transport**: Streamable HTTP (`GET` for the SSE stream, `POST` for client messages)
- **Auth header**: `Authorization: Bearer <your-token>`

For local development, point at `http://localhost:3000/api/v1/mcp` instead.

## Tools

All tools return JSON encoded as a single text content block. Error cases set `isError: true` and return a plain-text message.

### Instruments

| Tool | Description |
| --- | --- |
| `list_instruments` | List all registered instruments with run counts, watcher status, and file patterns. Optionally filter by `status` (`pending`, `active`, `inactive`). |
| `get_instrument` | Get full detail for an instrument by its kebab-case ID, including watcher online/offline counts. |

### Runs

| Tool | Description |
| --- | --- |
| `search_runs` | Paginated search across runs with filtering, sorting, and date range. Supports plate-reader metadata filters (`wavelength`, `measurementMode`, `measurementType`) and attribution filtering via `ranBy` (a user id or the literal `"unattributed"`). |
| `get_run` | Get a single run by its natural key (`instrumentId` + `runId`). |
| `list_run_files` | List all files attached to a run, including processing status and metadata. Use `get_file_download_url` on processed CSV files to access experimental results. |
| `get_run_archive` | Get a downloadable ZIP archive of all uploaded files for a run. Returns a 15-minute pre-signed S3 URL on a cache hit (clickable in a browser, no auth required), or a `building` job + `retryAfterSeconds` hint on a miss — call again after the suggested wait to poll. |

Both `get_run` and `search_runs` responses embed an `attributions` array on each run, listing the users who have claimed it (user id, display name, initials, avatar URL). No separate read tool is needed to inspect who ran a run.

### Run attribution

| Tool | Description |
| --- | --- |
| `claim_run` | **Write tool.** Mark a run as performed by the authenticated user. Idempotent. Only self-attribution is supported — the user id comes from the session token, never from an argument, so you cannot claim a run on behalf of another user. |
| `unclaim_run` | **Write tool.** Remove the authenticated user's attribution from a run. Idempotent. Annotated `destructiveHint: true` because removing attribution is user-visible across the dashboard and runs tables. |
| `list_run_attributors` | List distinct users who have claimed at least one run on a given instrument. Use the returned `userId` values to construct a `search_runs` call with `ranBy=<userId>`. |

### Files

| Tool | Description |
| --- | --- |
| `get_file` | Get detailed metadata for a single file by numeric ID. |
| `get_file_download_url` | Get a pre-signed S3 URL for downloading a file's raw contents. URLs expire after 15 minutes and can be fetched without additional authentication. |
| `reprocess_file` | **Write tool.** Re-run the Lambda processing workflow for a `failed` or `completed` file. Transitions the file back to `processing`. Annotated `destructiveHint: true` so clients can warn before invoking. |

### Watchers and system status

| Tool | Description |
| --- | --- |
| `get_system_status` | Dashboard-level overview of all instruments, watcher health, and pending upload counts. |
| `list_watchers` | List watcher agents with effective status, hostname, instrument assignment, and last heartbeat. Optionally filter by `instrumentId`. |
| `get_watcher_heartbeats` | Recent heartbeat history for a watcher, useful for diagnosing connectivity gaps and error trends. Configurable `hours` lookback (default 24, max 168). |

## Resources

Resources provide reference context that clients can attach to prompts without an explicit tool call.

| URI | Description |
| --- | --- |
| `datahub://instruments` | List of all instrument IDs, display names, and types. Useful as grounding context when constructing tool calls. |
| `datahub://instruments/{instrumentId}/filter-options` | Available filter values for an instrument. Plate readers expose wavelengths and measurement modes/types; gel-doc instruments expose capture types, imaging modes, wavelengths, and colors. Helps build valid `search_runs` queries. |

## Prompts

Prompts are scripted workflows the client surfaces to the user. Each prompt assembles a multi-step instruction that the model then executes using the tools above.

| Prompt | Args | Description |
| --- | --- | --- |
| `daily_summary` | `date` (optional, YYYY-MM-DD) | Summarize all instrument activity for a given day — run counts, failures, and system health. |
| `troubleshoot_instrument` | `instrumentId` | Diagnose connectivity or processing issues for an instrument by inspecting its status, watcher heartbeats, and recent runs. |
| `compare_runs` | `instrumentId`, `runId1`, `runId2` | Compare two runs on the same instrument side by side, highlighting differences in conditions and outcomes. |

## Example usage

Once installed, ask your client questions like:

- *"What instruments are active right now?"* → `list_instruments` with `status="active"`
- *"Show me all SpectraMax runs from last Friday."* → `search_runs` with an `instrumentId` and date range
- *"The gel-doc in Lab 3 stopped uploading — what's wrong?"* → `troubleshoot_instrument` prompt, which inspects the watcher list and heartbeat history
- *"Re-run processing for file 4217, we pushed a parser fix."* → `reprocess_file`. Clients typically confirm the destructive action with the user first.
- *"Claim run `2026-03-26_experiment` on the SpectraMax — I ran it this morning."* → `claim_run`. To find runs you've already claimed, use `search_runs` with `ranBy` set to your user id (discoverable via `list_run_attributors`).

## Troubleshooting

### `401 Unauthorized`

The Bearer token is missing, mistyped, revoked, or expired. Verify the token at **Settings > Access Tokens** and re-issue if necessary.

### Tools don't appear in the client

- Confirm the server is listed under `mcpServers` in the client config.
- Check for JSON syntax errors in the config file.
- Restart the client after editing — most clients don't hot-reload MCP server definitions.
- Hit `https://datahub.example.com/api/v1/mcp` with `curl -H "Authorization: Bearer <token>"` to confirm the endpoint responds.

### `get_file_download_url` vs. `get_run_archive`

- `get_file_download_url` returns a pre-signed S3 URL for a single file. Anyone with the link can fetch it for 15 minutes — no Data Hub credentials required on the follow-up request.
- `get_run_archive` returns the same kind of pre-signed S3 URL, but for a multi-file ZIP archive of an entire run. On a cache miss the Lambda builds the archive asynchronously and the tool returns `{ status: "building", jobId, retryAfterSeconds }`; call the tool again after the suggested wait until you get back `{ status: "ready", downloadUrl }`. Like `get_file_download_url`, the URL itself carries the auth, so the resulting link is browser-clickable without the original Bearer token.

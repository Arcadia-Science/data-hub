# MCP server

The Data Hub MCP server exposes instruments, runs, files, and watcher data to AI clients — such as Claude Desktop and Cursor — through the [Model Context Protocol](https://modelcontextprotocol.io/). Clients can list instruments, search runs, fetch experimental results, generate download URLs, and re-trigger Lambda processing, all through a single Bearer-authenticated HTTP endpoint served by the web app.

The server lives at `/api/v1/mcp` on the same Next.js deployment that serves the [REST API](api.md) and uses the MCP Streamable HTTP transport.

## Authentication

The MCP server accepts **Bearer tokens only** — session cookies are not supported. Create a personal access token in the web app at **Settings > Access Tokens**, then pass it in the `Authorization: Bearer <token>` header when configuring your client.

See [Managing tokens](guides/managing-tokens.md) for details on creating, using, and revoking tokens.

## Installation

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

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

Restart Claude Desktop. The `data-hub` server should appear in the MCP panel and its tools become available in conversations.

### Cursor

Edit `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

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

Reload Cursor. Tools are invoked via the agent automatically when relevant.

### Other clients

The endpoint follows the MCP Streamable HTTP spec, so any compliant client works. Configure it with:

- **URL**: `https://data-hub.arcadiascience.com/api/v1/mcp`
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
| `search_runs` | Paginated search across runs with filtering, sorting, and date range. Supports plate-reader metadata filters (`wavelength`, `measurementMode`, `measurementType`). |
| `get_run` | Get a single run by its natural key (`instrumentId` + `runId`). |
| `get_run_report_data` | Get structured experimental results for a run — plate maps, well data, kinetic traces, spectra, etc. This is the primary tool for accessing results. |
| `list_run_files` | List all files attached to a run, including processing status and metadata. |
| `get_run_archive_path` | Get the API path that streams a ZIP archive of all uploaded files for a run. Prepend the Data Hub origin and authenticate with the same Bearer token to download. |

### Files

| Tool | Description |
| --- | --- |
| `get_file` | Get detailed metadata for a single file by numeric ID. |
| `get_file_download_url` | Get a pre-signed S3 URL for downloading a file's raw contents. URLs expire after 15 minutes and can be fetched without additional authentication. |
| `reprocess_file` | **Write tool.** Re-run the Lambda processing workflow for a `failed` or `completed` file. Clears prior report data and transitions the file back to `processing`. Annotated `destructiveHint: true` so clients can warn before invoking. |

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
| `run_analysis` | `instrumentId`, `runId` | Fetch and interpret the experimental results for a specific run. |
| `troubleshoot_instrument` | `instrumentId` | Diagnose connectivity or processing issues for an instrument by inspecting its status, watcher heartbeats, and recent runs. |
| `compare_runs` | `instrumentId`, `runId1`, `runId2` | Compare two runs on the same instrument side by side, highlighting differences in conditions and outcomes. |

## Example usage

Once installed, ask your client questions like:

- *"What instruments are active right now?"* → `list_instruments` with `status="active"`
- *"Show me all SpectraMax runs from last Friday."* → `search_runs` with an `instrumentId` and date range
- *"Summarize the well data from run `2026-03-26_experiment` on the plate reader."* → `run_analysis` prompt, which chains `get_run`, `get_run_report_data`, and `list_run_files`
- *"The gel-doc in Lab 3 stopped uploading — what's wrong?"* → `troubleshoot_instrument` prompt, which inspects the watcher list and heartbeat history
- *"Re-run processing for file 4217, we pushed a parser fix."* → `reprocess_file`. Clients typically confirm the destructive action with the user first.

## Troubleshooting

### `401 Unauthorized`

The Bearer token is missing, mistyped, revoked, or expired. Verify the token at **Settings > Access Tokens** and re-issue if necessary.

### Tools don't appear in the client

- Confirm the server is listed under `mcpServers` in the client config.
- Check for JSON syntax errors in the config file.
- Restart the client after editing — most clients don't hot-reload MCP server definitions.
- Hit `https://data-hub.arcadiascience.com/api/v1/mcp` with `curl -H "Authorization: Bearer <token>"` to confirm the endpoint responds.

### `get_file_download_url` vs. `get_run_archive_path`

- `get_file_download_url` returns a pre-signed S3 URL that anyone with the link can use for 15 minutes — no Data Hub credentials required on the follow-up request. Use this when handing a file to a user or an untrusted downstream tool.
- `get_run_archive_path` returns a Data Hub API path. The archive endpoint streams the ZIP on demand and requires the same Bearer token the MCP session used. Use this when the downloader has the token (e.g., a script running in the same environment).

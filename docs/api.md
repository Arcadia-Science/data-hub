# REST API

The Data Hub API is served by the Next.js web application at `/api/v1/`. It is used by the watcher, the Lambda function, MCP clients, and the web dashboard.

## Authentication

The API supports two authentication methods:

- **Session cookies** — used by the web dashboard (Google OAuth via NextAuth).
- **Bearer tokens** — used by the watcher, Lambda, and MCP clients. Tokens are created in the web dashboard under personal access tokens and sent in the `Authorization: Bearer <token>` header.

Tokens are hashed with SHA-256 before storage. The plaintext token is shown once at creation time.

## Endpoints

### Instruments

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/instruments` | List all instruments |
| `POST` | `/api/v1/instruments` | Create a new instrument |
| `GET` | `/api/v1/instruments/:instrumentId` | Get instrument details (includes run and watcher counts) |

### Runs

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/instruments/:instrumentId/runs` | List runs for an instrument |
| `POST` | `/api/v1/instruments/:instrumentId/runs` | Create a new run |
| `GET` | `/api/v1/instruments/:instrumentId/runs/:runId` | Get run details |
| `PATCH` | `/api/v1/instruments/:instrumentId/runs/:runId` | Update a run |
| `DELETE` | `/api/v1/instruments/:instrumentId/runs/:runId` | Soft-delete a run |
| `POST` | `/api/v1/instruments/:instrumentId/runs/:runId/restore` | Restore a soft-deleted run |
| `GET` | `/api/v1/instrument-runs` | List runs across all instruments |

### Comments

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/instruments/:instrumentId/runs/:runId/comments` | List active comments on a run (oldest first) |
| `POST` | `/api/v1/instruments/:instrumentId/runs/:runId/comments` | Create a markdown comment on a run |
| `PATCH` | `/api/v1/instruments/:instrumentId/runs/:runId/comments/:commentId` | Edit a comment (author only; sets `edited_at`) |
| `DELETE` | `/api/v1/instruments/:instrumentId/runs/:runId/comments/:commentId` | Soft-delete a comment (author only) |

Comment bodies are markdown source, capped at 10 000 characters. Author-only mutations are enforced server-side and return `403 FORBIDDEN` for cross-user edit/delete attempts. Mutations on comments whose parent run has been soft-deleted return `409 CONFLICT`.

### Files

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/v1/instruments/:instrumentId/runs/:runId/files` | Create a file record |
| `GET` | `/api/v1/files/:fileId` | Get file details |
| `PATCH` | `/api/v1/files/:fileId` | Update file metadata |
| `GET` | `/api/v1/files/:fileId/download` | Get a pre-signed S3 download URL |
| `POST` | `/api/v1/instruments/:instrumentId/runs/:runId/request-upload` | Request file upload (manual mode) |
| `POST` | `/api/v1/instruments/:instrumentId/runs/:runId/request-upload-url` | Get a pre-signed S3 upload URL for a file |

### Watchers

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/watchers` | List all watchers |
| `POST` | `/api/v1/watchers/register` | Register a new watcher (returns `409 CONFLICT` if the instrument already has an active watcher; the existing watcher's id is included in `error.details.existing_watcher_id`) |
| `GET` | `/api/v1/watchers/:watcherId` | Get watcher details |
| `DELETE` | `/api/v1/watchers/:watcherId` | Deregister (soft-delete) a watcher |
| `POST` | `/api/v1/watchers/:watcherId/heartbeat` | Send a heartbeat |
| `GET` | `/api/v1/watchers/:watcherId/heartbeats` | Get heartbeat history |
| `POST` | `/api/v1/watchers/:watcherId/events` | Submit watcher events |
| `GET` | `/api/v1/watchers/:watcherId/config` | Get synced config YAML |
| `PUT` | `/api/v1/watchers/:watcherId/config` | Push config YAML and checksum |
| `GET` | `/api/v1/watchers/:watcherId/config-checksum` | Get the config checksum |
| `GET` | `/api/v1/watchers/:watcherId/upload-queue` | Get pending upload queue |
| `GET` | `/api/v1/watchers/:watcherId/update-check` | Get server-advertised release info (latest version, channel, mandatory flag); used by the watcher's self-update CLI and background auto-updater. See [Upgrading the watcher](guides/upgrading-the-watcher.md). |

### Archive jobs

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/instruments/:instrumentId/runs/:runId/download-archive` | Download the run archive. On cache hits returns `302` with a presigned S3 URL (or `200 { status: "ready", download_url, size_bytes }` if the caller sent `Accept: application/json`). On cache misses always returns `202 { status: "building", job_id }` and dispatches the build asynchronously; the same URL re-issued is the canonical poll target — every poll re-runs the S3 HEAD, so a finished build is visible the moment the multipart upload lands. Optional `?file_ids=1,2,3` narrows the archive to a subset of files (always intersected with the run's own files). |
| `PATCH` | `/api/v1/archive-jobs/:id` | Lambda callback: marks an async build as `ready` (with `archive_bucket`, `archive_key`, `size_bytes`) or `failed` (with `error_message`). Stamps `completed_at` on terminal transitions. Uses standard PAT/session auth — the Lambda calls this with its `DATA_HUB_API_KEY` PAT. The UI does not trust this row's `status` for download readiness (it polls `/download-archive`, which short-circuits on an S3 HEAD), so a tampered row at worst breaks its own download. |

The download-archive endpoint sits in front of a Lambda-driven builder pipeline that produces zips in S3 and serves them via presigned URLs, so download bytes never travel through Vercel. See [Run archives](run-archives.md) for the full flow, cache semantics, and operator runbook.

### Tokens

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/tokens` | List personal access tokens |
| `POST` | `/api/v1/tokens` | Create a new token |
| `DELETE` | `/api/v1/tokens/:id` | Revoke a token |

### MCP (Model Context Protocol)

| Method | Path | Description |
| --- | --- | --- |
| `GET`, `POST` | `/api/v1/mcp` | MCP server endpoint (Streamable HTTP transport) |

The MCP server exposes Data Hub data to AI clients (e.g. Claude Desktop, Cursor) via the [Model Context Protocol](https://modelcontextprotocol.io/). It uses Bearer token authentication only — session cookies are not supported.

See the [MCP server docs](mcp.md) for the full tool, resource, and prompt reference and installation instructions for Claude Desktop and Cursor.

## Error responses

Errors follow a consistent shape:

```json
{
  "code": "NOT_FOUND",
  "message": "Instrument not found.",
  "details": null
}
```

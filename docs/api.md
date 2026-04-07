# REST API

The Data Hub API is served by the Next.js web application at `/api/v1/`. It is used by the watcher, the Lambda function, and the web dashboard.

## Authentication

The API supports two authentication methods:

- **Session cookies** — used by the web dashboard (Google OAuth via NextAuth).
- **Bearer tokens** — used by the watcher and Lambda. Tokens are created in the web dashboard under personal access tokens and sent in the `Authorization: Bearer <token>` header.

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

### Files

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/v1/instruments/:instrumentId/runs/:runId/files` | Create a file record |
| `GET` | `/api/v1/files/:fileId` | Get file details |
| `PATCH` | `/api/v1/files/:fileId` | Update file metadata |
| `GET` | `/api/v1/files/:fileId/download` | Get a pre-signed S3 download URL |
| `POST` | `/api/v1/instruments/:instrumentId/runs/:runId/request-upload` | Request file upload (manual mode) |

### Analyses

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/v1/instruments/:instrumentId/runs/:runId/analyses` | Create an analysis record |

### Watchers

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/watchers` | List all watchers |
| `POST` | `/api/v1/watchers/register` | Register a new watcher |
| `GET` | `/api/v1/watchers/:watcherId` | Get watcher details |
| `POST` | `/api/v1/watchers/:watcherId/heartbeat` | Send a heartbeat |
| `GET` | `/api/v1/watchers/:watcherId/heartbeats` | Get heartbeat history |
| `POST` | `/api/v1/watchers/:watcherId/events` | Submit watcher events |
| `GET` | `/api/v1/watchers/:watcherId/config` | Get synced config YAML |
| `PUT` | `/api/v1/watchers/:watcherId/config` | Push config YAML and checksum |
| `GET` | `/api/v1/watchers/:watcherId/config-checksum` | Get the config checksum |
| `GET` | `/api/v1/watchers/:watcherId/upload-queue` | Get pending upload queue |

### Tokens

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/tokens` | List personal access tokens |
| `POST` | `/api/v1/tokens` | Create a new token |
| `DELETE` | `/api/v1/tokens/:id` | Revoke a token |

## Error responses

Errors follow a consistent shape:

```json
{
  "code": "NOT_FOUND",
  "message": "Instrument not found.",
  "details": null
}
```

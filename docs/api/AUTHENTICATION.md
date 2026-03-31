# API: Authentication

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md) (`users`, `accounts`, `sessions`, `personal_access_tokens` tables).

## Base URL

| Environment | URL |
|---|---|
| Staging | `https://data-hub-staging.arcadiascience.com/api/v1` |
| Production | `https://data-hub.arcadiascience.com/api/v1` |

These are implemented as Next.js API route handlers under `app/api/`.

## Authentication Mechanisms

Three authentication mechanisms, distinguished by the caller:

| Caller | Mechanism | Details |
|---|---|---|
| Web UI (browser) | **Google OAuth via Auth.js** | Users sign in with their Google account. Auth.js manages the OAuth flow and maintains a session cookie. Only `@arcadiascience.com` email addresses are permitted. |
| File upload service (watcher) | **Personal access token** | A user creates a token in the web UI and configures the watcher's `.env` with it. Sent as `Authorization: Bearer dhub_...`. |
| Lambda function | **Personal access token** | Same mechanism as the watcher. A token is created in the web UI and stored in the Lambda's environment variables. |

## Auth.js Configuration

- Provider: Google
- Adapter: Drizzle (using the `users`, `accounts`, and `sessions` tables)
- Email domain restriction: only Google accounts with `@arcadiascience.com` are allowed to sign in. All other domains are rejected at the OAuth callback.
- Session strategy: database sessions (not JWT) to support server-side session invalidation.

## Personal Access Token Validation

API middleware on all `/api/` routes (except the Auth.js routes and public health checks) checks for authentication in the following order:

1. **Session cookie** — if present and valid, the request is authenticated as the session's user.
2. **`Authorization: Bearer dhub_...` header** — if present, hash the token with SHA-256 and look up `personal_access_tokens.token_hash`. If found and not expired, the request is authenticated as the token's user. Update `last_used_at`.
3. If neither is present or valid, return `401 Unauthorized`.

## Endpoints — Personal Access Tokens

These endpoints are used by the web UI's settings page. All require an authenticated session (cookie-based auth only — tokens cannot be used to manage tokens).

### `GET /api/v1/tokens`

Lists the current user's personal access tokens.

**Response:**

```json
[
  {
    "id": "a1b2c3d4-...",
    "name": "Plate Reader PC",
    "token_prefix": "dhub_a1b2",
    "last_used_at": "2026-03-26T20:15:00Z",
    "expires_at": null,
    "created_at": "2026-03-01T10:00:00Z"
  }
]
```

The full token value is never returned — only the prefix.

### `POST /api/v1/tokens`

Creates a new personal access token. The plaintext token is returned **once** in the response.

**Request body:**

```json
{
  "name": "Plate Reader PC",
  "expires_at": "2027-03-26T00:00:00Z"
}
```

`expires_at` is optional. If omitted, the token does not expire.

**Response:** `201 Created`

```json
{
  "id": "a1b2c3d4-...",
  "name": "Plate Reader PC",
  "token": "dhub_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0",
  "token_prefix": "dhub_a1b2",
  "expires_at": "2027-03-26T00:00:00Z",
  "created_at": "2026-03-26T20:15:00Z"
}
```

The `token` field contains the full plaintext token. The UI must display it with a copy-to-clipboard button and a warning that it will not be shown again.

### `DELETE /api/v1/tokens/:id`

Revokes (deletes) a personal access token. Users can only delete their own tokens.

**Response:** `204 No Content`

## Acceptance Criteria

1. Users can sign in with a `@arcadiascience.com` Google account via Auth.js. Non-matching email domains are rejected.
2. Authenticated users can create personal access tokens on the settings page. The full token is displayed once at creation and never again.
3. API requests with a valid `Authorization: Bearer dhub_...` header are authenticated as the token's owner. Expired and deleted tokens are rejected.

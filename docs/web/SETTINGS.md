# Web: Settings & Sign-in

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [api/AUTHENTICATION.md](../api/AUTHENTICATION.md), [web/DASHBOARD.md](./DASHBOARD.md) (shared UI patterns).

## Settings — Access Tokens (`/settings/tokens`)

Allows authenticated users to create and manage personal access tokens for API authentication.

**Content:**
- Table of the user's existing tokens: name, token prefix (e.g., `dhub_a1b2...`), last used date, expiry date, created date.
- "Create token" button that opens a form:
  - Token name (required).
  - Expiration (optional — select from presets like 30 days, 90 days, 1 year, or no expiry).
  - On submit, the full token is displayed **once** with a copy-to-clipboard button and a warning: "Make sure to copy your token now. You won't be able to see it again."
- Delete button per token with a confirmation dialog.

## Sign-in (`/auth/signin`)

The Auth.js sign-in page.

**Content:**
- "Sign in with Google" button.
- After successful authentication, redirects to the dashboard.
- If the user's email domain is not `@arcadiascience.com`, displays an error message and does not create a session.

## Acceptance Criteria

1. Authenticated users can create personal access tokens on the settings page. The full token is displayed once at creation and never again (UI side of [api/AUTHENTICATION.md](../api/AUTHENTICATION.md) acceptance criteria).

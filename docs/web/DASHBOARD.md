# Web: Dashboard & Shared UI Patterns

Prerequisite reading: [ARCHITECTURE.md](../ARCHITECTURE.md), [api/INSTRUMENT_RUNS.md](../api/INSTRUMENT_RUNS.md).

## Technology

- **Framework:** Next.js (App Router)
- **Language:** TypeScript
- **ORM:** Drizzle ORM (with `drizzle-kit` for migrations)
- **Auth:** Auth.js (NextAuth v5) with Google OAuth provider and the Drizzle adapter
- **Styling:** Tailwind CSS + shadcn/ui
- **Deployment:** Vercel (or similar; must support Next.js API routes and server-side rendering)

## Dashboard (`/`)

The landing page. Shows a summary of recent activity across all instruments.

**Content:**
- Summary cards per instrument: instrument name, count of runs, last run date, watcher status (online / offline / no watcher). For instruments with manual-mode watchers, show the count of runs awaiting upload (runs with `reported_files` and no `upload_requested_at`) as a badge.
- A combined recent runs table across all instruments, sorted by `created_at DESC`. Each row shows: instrument name, run ID, file processing summary (e.g., "3/3 files processed" or "1 failed"), metadata summary, timestamp. Rows link to the run detail page. The file processing summary uses color to indicate state: green when all files are `completed`, red when any file is `failed`, gray when files are still `uploaded`/`processing`.
- Filters: instrument (multi-select dropdown), date range.
- Search: by run ID (partial match).
- Soft-deleted runs (`deleted_at` set) are excluded by default. A "Show deleted" toggle reveals them with a visual strikethrough or muted style.

## Shared UI Patterns

- **Pagination:** cursor-based or offset pagination on all list views. Default 25 rows per page.
- **Empty states:** meaningful messages when no data is available (e.g., "No runs recorded for this instrument yet").
- **Loading states:** skeleton loaders while data is fetched.
- **Error states:** clear error messaging with retry actions.
- **Timestamps:** displayed in the user's local timezone with relative formatting (e.g., "2 hours ago") and full timestamp on hover.

## Acceptance Criteria

1. The dashboard page lists recent runs across all instruments with working filters and search.

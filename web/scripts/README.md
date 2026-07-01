# Scripts

All scripts require the `DATABASE_URL` environment variable (loaded automatically from `.env` via `dotenv`).

## Local-only safety gate

`reset-database.ts` and `seed-database.ts` are destructive. They refuse to run
unless `DATABASE_URL` is exactly:

```
postgres://postgres:postgres@127.0.0.1:5432/data-hub-local
```

This guard lives in `assert-local-db.ts` and protects `db:reseed` as well
(which chains reset → push → seed). If you genuinely need to run these
against a different database, update the expected URL in
`assert-local-db.ts` rather than removing the check.

`clear-run-file-records.ts` is the deliberate exception: it targets a
**remote** database on purpose, so it does not use the local-only gate. Its
guardrails are different (dry-run by default + explicit `--confirm`) — see
its section below.

## `reset-database.ts`

Drops and recreates the `public` schema, wiping all tables and data. Used as the first step in a full database rebuild.

### Usage

```sh
npm run db:reset
```

After running, you'll need to recreate the schema.

```sh
npm run db:push
```

## `seed-database.ts`

Populates the database with a believable steady state: a workspace admin user
(`dev@local`) + PAT, one instrument per type, watchers with heartbeats/events,
runs with files, comments, attributions, and archive jobs in each lifecycle
state. Clears existing rows first, then prints a sign-in email and a fresh PAT
for API calls.

### Usage

```sh
# Seed on top of the current schema
npm run db:seed

# Reset → push → seed (the usual loop)
npm run db:reseed
```

The seed's final step drives the lambda over each fixture-bearing run so the
dashboard shows real processed artifacts. That step is **skipped** unless the
dev server is already running (see `process-seeded-fixtures.ts` below); the
seed prints a hint when it skips.

## `process-seeded-fixtures.ts`

Post-hoc fixture processing for when the seed skipped it (typically because
`npm run dev` wasn't up during `npm run db:reseed`). Mints a fresh PAT for the
dev user and drives the lambda's `data-hub-process` handler over the seeded
fixtures.

### Usage

```sh
# one terminal
npm run dev

# another terminal, once the dev server is reachable
npm run db:process-fixtures
```

## `clear-run-file-records.ts`

Hard-deletes run and file records (and everything that FK-references them:
`notifications`, `run_comments`, `run_attributions`, `archive_jobs`, `files`, `instrument_runs`) while **preserving `instruments` and `watchers`**, so lab instrument PCs stay registered and can be re-pointed between environments. 

Used to reset the long-lived "staging-as-prod" database before production cutover. It does **not** touch S3 — object deletion is a separate, manual step.

Unlike the scripts above, this one intentionally targets a remote database,
so it skips the local-only gate. Instead it is dry-run by default (prints row counts of both cleared and preserved tables), requires `--confirm` to delete, echoes the redacted target host, and refuses to run against the local dev database. All deletes run in a single transaction.

### Usage

```sh
# Dry run — verify target + counts, no changes
DATABASE_URL='<remote-url>' npm run db:clear-runs

# Commit the wipe
DATABASE_URL='<remote-url>' npm run db:clear-runs -- --confirm

# Also drop watcher heartbeats/events (kept by default)
DATABASE_URL='<remote-url>' npm run db:clear-runs -- --confirm --clear-watcher-activity
```

## Helper modules (not run directly)

- `assert-local-db.ts` — the local-only safety gate imported by
  `reset-database.ts`, `seed-database.ts`, and `process-seeded-fixtures.ts`
  (see [Local-only safety gate](#local-only-safety-gate)).
- `process-fixtures.ts` — shared lambda probe/spawn logic imported by
  `seed-database.ts` and `process-seeded-fixtures.ts`.

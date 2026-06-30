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

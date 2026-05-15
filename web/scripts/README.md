# Scripts

All scripts require the `DATABASE_URL` environment variable (loaded automatically from `.env` via `dotenv`).

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

# Database schema

- After you edit `web/lib/db/schema.ts`, run `npm run db:generate` in `web/` and commit the SQL and `meta/` files it writes under `web/drizzle/`. Local development applies the schema with `db:push`. `staging` and `production` apply `web/drizzle/` through `.github/workflows/apply-migrations.yml` when the change merges.
- Never edit a migration after it merges, because environments that already applied it won't run it again. Write a new migration instead.
- A migration that creates an extension or collation needs the same statement in `web/scripts/reset-database.ts` and `web/tests/integration/global-setup.ts`, because `db:push` doesn't run migrations.
- Never hand-edit `web/lib/db/auth-schema.ts`. Run `npm run db:generate-auth-schema` in `web/` instead. The Better Auth skill's `npx auth generate` skips this repo's changes to that file.
- Don't drop a column in the same pull request that stops using it. Drop it in a later one, so rolling back the first still works.

Drizzle docs: https://orm.drizzle.team/llms.txt

# Data Hub

This directory contains the source code for the Data Hub web application and API.

## Development

### Prerequisites

- Node.js >= 22
- PostgreSQL >= 15
- Google OAuth client (for authentication)

### Quickstart

1. **Install dependencies**

   ```sh
   npm install
   ```

2. **Configure environment variables**

   ```sh
   # Copy the example `.env` file.
   cp .env.example .env

   # Pull environment variables from Vercel using the Vercel CLI.
   vercel env pull
   ```

3. **Set up the database**

   ```sh
   # Create local PostgreSQL database.
   createdb data-hub-local

   # Push the schema.
   npm run db:push
   ```

4. **Start the dev server**

   ```sh
   npm run dev
   ```

   The app runs at [http://localhost:3000](http://localhost:3000).

### Scripts

| Command                   | Description                                                                      |
| ------------------------- | -------------------------------------------------------------------------------- |
| `npm run dev`             | Start dev server (Turbopack)                                                     |
| `npm run build`           | Production build                                                                 |
| `npm run start`           | Start production server                                                          |
| `npm run lint:check`      | Check formatting + lint with Biome (read-only)                                   |
| `npm run lint:fix`        | Format and apply safe lint fixes with Biome                                      |
| `npm run typecheck`       | Run the TypeScript compiler (no emit)                                            |
| `npm run check`           | Lint check + typecheck                                                            |
| `npm run precommit`       | Lint fix + typecheck (run before committing)                                     |
| `npm run db:generate`     | Generate Drizzle migration files                                                 |
| `npm run db:migrate`      | Apply pending migrations                                                         |
| `npm run db:push`         | Push schema to database (no migration files)                                     |
| `npm run db:studio`       | Open Drizzle Studio GUI                                                          |
| `npm run db:reset`        | Drop and re-create the public schema                                             |

### Environment variables

All environment variables can be pulled from the Vercel project using the [Vercel CLI](https://vercel.com/docs/cli):

```sh
vercel env pull
```

You can also manually copy and paste these from your Vercel project's Environment Variables page.

See the table below for a summary of environment variables configured for this application.

| Variable                    | Required | Purpose                                                |
| --------------------------- | -------- | ------------------------------------------------------ |
| `DATABASE_URL`              | Yes      | PostgreSQL connection string                           |
| `AUTH_GOOGLE_ID`            | Yes      | Google OAuth client ID                                 |
| `AUTH_GOOGLE_SECRET`        | Yes      | Google OAuth client secret                             |
| `AUTH_SECRET`               | Yes      | Better Auth session encryption key                     |
| `BETTER_AUTH_URL`           | Yes      | Public origin of this app (e.g. `http://localhost:3000`) |
| `ADMIN_EMAILS`              | No       | Comma-separated email allowlist for the workspace admin role. Listed users are auto-promoted to admin on every sign-in (one-way). Once at least one admin exists, additional admins can be promoted via **Settings > Members**. |

## CI

A GitHub Actions workflow (`.github/workflows/typescript-lint.yml`) runs on every push to `staging` and `production`, as well as pull requests targeting both branches. It executes two checks:

1. **Lint and format check** — `npm run lint:check` (Biome, via Ultracite — combined formatter + linter, read-only)
2. **Type check** — `npm run typecheck` (TypeScript compiler)

Run `npm run precommit` locally before pushing to catch the same issues earlier.

## Deployment

Data Hub is self-hosted. See the [First-time deployment guide](../developer-docs/first-time-deployment.md) for standing up an environment and [CI and deployment](../developer-docs/ci-and-deployment.md) for how deploys run.

### Web application

The Data Hub web application is deployed on Vercel. Every branch (as well as every commit) in the repository generates a unique preview deployment.

### Database

Data Hub has two main environments: staging and production. Each environment uses its own dedicated PostgreSQL instance, which you can host on any Postgres service.

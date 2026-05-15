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
| `npm run lint`            | Run ESLint                                                                       |
| `npm run format`          | Format code with Prettier                                                        |
| `npm run format:check`    | Check formatting without writing                                                 |
| `npm run typecheck`       | Run the TypeScript compiler (no emit)                                            |
| `npm run precommit`       | Format + lint + typecheck (run before committing)                                |
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

You can also manually copy and paste these from the project's [Environment Variables](https://vercel.com/arcadia-science/data-hub/settings/environment-variables) page.

See the table below for a summary of environment variables configured for this application.

| Variable                    | Required | Purpose                                                |
| --------------------------- | -------- | ------------------------------------------------------ |
| `DATABASE_URL`              | Yes      | PostgreSQL connection string                           |
| `AUTH_GOOGLE_ID`            | Yes      | Google OAuth client ID                                 |
| `AUTH_GOOGLE_SECRET`        | Yes      | Google OAuth client secret                             |
| `AUTH_SECRET`               | Yes      | NextAuth session encryption key                        |

## CI

A GitHub Actions workflow (`.github/workflows/typescript-lint.yml`) runs on every push to `staging` and `production`, as well as pull requests targeting both branches. It executes three checks:

1. **Format check** — `npm run format:check` (Prettier)
2. **Lint** — `npm run lint` (ESLint)
3. **Type check** — `npm run typecheck` (TypeScript compiler)

Run `npm run precommit` locally before pushing to catch the same issues earlier.

## Deployment

### Web application

The Data Hub web application is deployed on Vercel. Every branch (as well as every commit) in the repository generates a unique preview deployment.

You can find the Vercel project [here](https://vercel.com/arcadia-science/data-hub).

### Database

Data Hub has two main environments: staging and production. Each environment uses its own dedicated database instance, both of which are hosted on Render.

You can find the Render project [here](https://dashboard.render.com/project/prj-d75d0jma2pns738r4110).

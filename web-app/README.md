# Data Hub

This directory contains the source code for the Data Hub web application and API.

## Development

### Prerequisites

- Node.js >= 22
- PostgreSQL >= 15
- Google OAuth client (for authentication)
- AWS S3 bucket (for safety data sheets)
- Slack bot token (for notifications)
- Bellwether API credentials (for fetching purchase orders)

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
| `npm run db:push-reset`   | Force-push and reset database schema                                             |
| `npm run db:studio`       | Open Drizzle Studio GUI                                                          |
| `npm run db:import`       | Import inventory from Google Sheets CSV export                                   |
| `npm run db:reset`        | Drop and re-create the public schema                                             |
| `npm run db:sync-orders`  | Sync orders from Bellwether API                                                  |
| `npm run db:init`         | Reset database, push schema, import inventory, upload SDS files, and sync orders |
| `npm run db:update-roles` | Update roles for Lab Ops team                                                    |

### Environment variables

All environment variables can be pulled from the Vercel project using the [Vercel CLI](https://vercel.com/docs/cli):

```sh
vercel env pull
```

You can also manually copy and paste these from the project's [Environment Variables](https://vercel.com/arcadia-science/chemidex/settings/environment-variables) page.

See the table below for a summary of environment variables configured for this application.

| Variable                    | Required | Purpose                                                |
| --------------------------- | -------- | ------------------------------------------------------ |
| `DATABASE_URL`              | Yes      | PostgreSQL connection string                           |
| `AUTH_GOOGLE_ID`            | Yes      | Google OAuth client ID                                 |
| `AUTH_GOOGLE_SECRET`        | Yes      | Google OAuth client secret                             |
| `AUTH_SECRET`               | Yes      | NextAuth session encryption key                        |
| `SLACK_BOT_TOKEN`           | No       | Slack bot token for notifications                      |
| `SLACK_CHANNEL_ID`          | No       | Slack channel to post to                               |
| `BELLWETHER_API_URL`        | No       | Bellwether procurement API base URL                    |
| `BELLWETHER_API_KEY`        | No       | Bellwether API key                                     |
| `BELLWETHER_API_EMAIL`      | No       | Email address for Bellwether API authentication        |
| `CRON_SECRET`               | No       | Secret used to authenticate Vercel cron job requests   |
| `NEXT_PUBLIC_AWS_S3_BUCKET` | No       | S3 bucket for SDS uploads                              |
| `NEXT_PUBLIC_AWS_S3_REGION` | No       | AWS region for the S3 bucket                           |
| `AWS_ACCESS_KEY_ID`         | No       | AWS access key                                         |
| `AWS_SECRET_ACCESS_KEY`     | No       | AWS secret key                                         |
| `VERCEL_URL`                | No       | The application URL (automatically set in deployments) |

## CI

A GitHub Actions workflow (`.github/workflows/lint-and-typecheck.yml`) runs on every push to `main` and on pull requests targeting `main`. It executes three checks:

1. **Format check** — `npm run format:check` (Prettier)
2. **Lint** — `npm run lint` (ESLint)
3. **Type check** — `npm run typecheck` (TypeScript compiler)

Run `npm run precommit` locally before pushing to catch the same issues earlier.

## Deployment

### Web application

The Chemidex web application is deployed on Vercel. Every branch (as well as every commit) in the repository generates a unique preview deployment.

You can find the Vercel project [here](https://vercel.com/arcadia-science/chemidex).

### Database

As of March 2026, Chemidex runs in two main environments: preview and production. Each environment uses its own dedicated database instance, both of which are hosted on Render.

You can find the Render project [here](https://dashboard.render.com/project/prj-d6ot92v5gffc738perfg).

#### Migrations

As of March 2026, database migrations are performed manually from a local machine, typically after code changes have been deployed to Vercel.

Currently, this manual approach is manageable because only one software engineer is actively developing the project, and all preview deployments share a single database instance. Looking ahead, as the team or deployment complexity grows, we plan to consider assigning a dedicated database to each preview deployment to better support concurrent development and testing workflows.

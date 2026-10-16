# Web app

## Next.js

This app runs Next.js 16, which changed APIs that most training data predates. For example, middleware is now `web/proxy.ts`. Before you use a Next.js API you're unsure about, read its guide in `web/node_modules/next/dist/docs/`.

## Checking changes in the running app

With `make dev` running, use the `next-dev-loop` skill. It reads errors, logs, and routes from `http://localhost:3000/_next/mcp` and drives the page with `agent-browser`. Sign in at `/login` with "Sign in (dev)" as `alice@example.com`.

## Rules

- Upgrade `better-auth` and every `@better-auth/*` package together, to the same version. Releases 1.7.0 through 1.7.7 break MCP client registration.
- Read and write `localStorage` only through `parseVersioned` and `serializeVersioned` in `web/lib/versioned-storage.ts`, and keep data written by the previous release readable. Tabs still open on the old release share the same storage.
- Instrument and run IDs can contain `%`, `#`, `?`, and spaces. Encode them once with `encodeURIComponent` when you build a URL, and decode them once when you read one.
- S3 returns 416 for a byte-range request on an empty object, and `Content-Type` can carry parameters such as `; charset=utf-8`. Handle both.
- `web/microfrontends.json` is the only routing config for both the web app and the docs site. Change routing, fallbacks, or `packageName` there.

## External docs

Check the current docs before you change an integration:

- Slack: https://docs.slack.dev/llms.txt. Any page also works with `.md` on the end.
- Linear: https://linear.app/llms.txt. Data Hub reaches Linear through `@arcadiascience/app-feedback-toolkit`.
- Vercel: https://vercel.com/docs/llms.txt
- Better Auth: https://www.better-auth.com/llms.txt. Use the 1.7 docs to match the installed version.
- Amazon S3: https://docs.aws.amazon.com/AmazonS3/latest/userguide/llms.txt

## Skills

- `vercel-react-best-practices` (vercel-labs/agent-skills): React and Next.js components, data fetching, and performance.
- `next-best-practices` (vercel-labs/openreview): Next.js file conventions and Server Component boundaries.
- `next-upgrade` (vercel-labs/openreview): upgrading Next.js.
- `next-dev-loop` (vercel/next.js): checking a change in the running app.
- `agent-browser` (vercel-labs/agent-browser): driving a real browser for `next-dev-loop`.
- `nuqs`, pinned at https://github.com/pproenca/dot-skills/tree/3791a24754a7040d7015cc07bc240c4fbe481e20/skills/.curated/nuqs: URL query state.
- `zod`, pinned at https://github.com/pproenca/dot-skills/tree/c34c29a4b4fa079a18d9d3ee9f727aa11197ff3b/skills/.curated/zod: Zod schemas in the API, MCP tools, and forms.
- `drizzle-orm-patterns`, pinned at https://github.com/giuseppe-trisciuoglio/developer-kit/tree/08a045b2694b090d9d93019f6395c1cbbc0f1011/plugins/developer-kit-typescript/skills/drizzle-orm-patterns: Drizzle queries, transactions, and schema.
- `better-auth-best-practices`, `better-auth-security-best-practices`, and `create-auth` (better-auth/skills): auth config, hardening, and adding a sign-in method.
- `vercel-microfrontends` (vercel/microfrontends): changes to `web/microfrontends.json`.
- `aws-sdk-js-v3-usage` (aws/agent-toolkit-for-aws): the S3 code in `web/lib/s3.ts`.
- `block-kit` and `slack-api` (slackapi/slack-skills-plugin): Slack messages and Web API calls in `web/lib/slack/`.
- `vercel-functions`, `env-vars`, and `access-protected-vercel-deployment` (vercel/vercel-plugin): the cron job in `web/vercel.json`, environment variables, and testing protected preview deployments.

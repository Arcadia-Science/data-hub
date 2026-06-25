# Data Hub Documentation

The public documentation site for [Data Hub](https://github.com/Arcadia-Science/data-hub),
built with [Fumadocs](https://fumadocs.dev) on Next.js. This is a standalone app: it has its
own dependencies and can be deployed as its own Vercel project (root directory `docs/`),
separate from the SSO-gated product app in `web/`.

Unlike the product app, this site is intentionally **public and indexable** — it ships a
sitemap, a permissive `robots.txt`, and clean Markdown endpoints for AI agents.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
```

Copy `.env.example` to `.env.local` and fill in values as needed.

| Command              | Description                                  |
| -------------------- | -------------------------------------------- |
| `npm run dev`        | Start the dev server                         |
| `npm run build`      | Production build                             |
| `npm run start`      | Start the production server                  |
| `npm run lint`       | Biome lint + format check (read-only)        |
| `npm run format`     | Biome format (writes)                        |
| `npm run types:check`| Generate types and run the TypeScript check  |

## Content

Documentation lives in `content/docs/*.mdx`, with navigation ordered by
`content/docs/meta.json`. Page frontmatter (`title`, `description`) drives metadata.

## AI agent / LLM endpoints

All read from the same content source, so they stay in sync with the site:

- `/llms.txt` — index of every page (titles, URLs, descriptions).
- `/llms-full.txt` — full Markdown dump of the corpus.
- `/docs/<path>.md` and `Accept: text/markdown` content negotiation (see `proxy.ts`) —
  serve the raw Markdown of any page.

## Search and Ask AI

- **Search**: built-in Orama search (`src/app/api/search/route.ts`).
- **Ask AI**: chat widget backed by `src/app/api/chat/route.ts`, which streams through the
  Vercel AI Gateway. Set `AI_GATEWAY_API_KEY` (or rely on Vercel OIDC) to enable it.

## Environment variables

| Variable               | Required | Purpose                                                          |
| ---------------------- | -------- | ---------------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL` | Prod     | Canonical site URL for metadata, OG, sitemap, and robots.        |
| `AI_GATEWAY_API_KEY`   | For chat | Authenticates the Ask AI widget (auto via OIDC on Vercel).       |
| `AI_GATEWAY_MODEL`     | No       | Overrides the default chat model id.                             |

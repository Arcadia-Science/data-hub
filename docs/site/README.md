# Data Hub Documentation

The public documentation site for [Data Hub](https://github.com/Arcadia-Science/data-hub), built with [Fumadocs](https://fumadocs.dev) on Next.js. This is a standalone app: it has its own dependencies and is deployed as its own Vercel project (Root Directory `docs/site`), separate from the SSO-gated product app in `web/`. It is published at <https://datahub.arcadiascience.com/docs> as a Vercel Microfrontends child of the web app.

Unlike the product app, this site is intentionally **public and indexable** — it ships a sitemap, a permissive `robots.txt`, and clean Markdown endpoints for AI agents.

The developer docs in `docs/developer/` are plain Markdown for contributors and are not part of this site.

## Development

Run these from `docs/site/`:

```bash
npm install
npm run dev      # http://localhost:<port> (the port comes from the microfrontends config)
```

Copy `.env.example` to `.env.local` and fill in values as needed. From the repository root, `make docs-dev` starts the same dev server.

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `npm run dev`        | Start the dev server                              |
| `npm run build`      | Production build                                  |
| `npm run start`      | Start the production server                       |
| `npm run lint:check` | Ultracite (Biome) lint + format check (read-only) |
| `npm run lint:fix`   | Ultracite (Biome) lint + format auto-fix (writes) |
| `npm run typecheck`  | Generate types and run the TypeScript check       |
| `npm run check:links`| Check links between the docs, web app, and changelog |

## Content

Documentation lives in `content/docs/*.mdx`, with navigation ordered by
`content/docs/meta.json`. Page frontmatter (`title`, `description`) drives metadata.

The API, MCP, and watcher CLI reference pages render from three generated files in `src/lib/`
(`openapi.snapshot.json`, `mcp-catalog.snapshot.json`, `cli-catalog.snapshot.json`). Regenerate
them with `make docs-catalogs` from the repository root; CI fails when they are out of date.

## AI agent / LLM endpoints

All read from the same content source, so they stay in sync with the site:

- `/llms.txt` — index of every page (titles, URLs, descriptions).
- `/llms-full.txt` — full Markdown dump of the corpus.
- `/docs/<path>.md` and `Accept: text/markdown` content negotiation (see `proxy.ts`) — serve the raw Markdown of any page.

## Search

Built-in Orama search (`src/app/docs/api/search/route.ts`).

## Environment variables

| Variable               | Required | Purpose                                                   |
| ---------------------- | -------- | --------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL` | Prod     | Canonical site URL for metadata, OG, sitemap, and robots. |

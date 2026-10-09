# AGENTS.md

## What this folder is

This is the **public documentation site** for [Data Hub](https://github.com/Arcadia-Science/data-hub) — a standalone Fumadocs/Next.js app that lives in `docs/site/` of the `data-hub` repository. It is deployed as its own Vercel project but served under the product's domain at https://datahub.arcadiascience.com/docs (see [Microfrontends](#microfrontends) below). It holds all user-, operator-, and admin-facing documentation: installing a watcher, adding an instrument, managing tokens, security/permissions, and full CLI/config/API reference.

If you're looking for how to *contribute to or self-host Data Hub itself* (architecture internals, local dev setup, conventions, CI/ops, deploying the web app and AWS infrastructure, package references), that content lives in `docs/developer/` next to this folder. Those are plain Markdown files read on GitHub. This site does not render them, because the site only reads `content/docs/`. Link to them from pages here with `https://github.com/Arcadia-Science/data-hub/blob/production/docs/developer/<file>.md`; `npm run check:links` fails on a broken link or a link to another branch.

Run every command below from `docs/site/`, or use the `make docs-*` targets from the repository root.

## Content structure

- Pages live in `content/docs/*.mdx`; nav order comes from `content/docs/meta.json` (edit both when adding or removing a page).
- Every page's frontmatter needs `title` and `description` — they drive page metadata and the `/llms.txt` index.
- Start each page with an `<Audience>...</Audience>` tag naming who it's for (lab operators, admins, engineers, developers/integrators) — pages mix audiences otherwise and readers can't tell if a page applies to them.
- Custom MDX components available: `<Audience>`, `<Callout type="info"|"warn">`, `<Steps>`/`<Step>`, `<Cards>`/`<Card>`. Prefer these over plain prose for multi-step walkthroughs and warnings, to match the rest of the site.
- Cross-reference other pages with relative site paths (`/docs/<slug>` or `/docs/<slug>#<heading-id>`), not raw `content/docs/*.mdx` file paths.

## OpenAPI API docs

- Generated operation pages under `/docs/api/*` come from the committed snapshot `src/lib/openapi.snapshot.json` via `fumadocs-openapi` (`src/lib/openapi.ts` + `staticSource`). The docs build needs no network.
- The snapshot is generated from the API definition in `web/lib/api/openapi/`. After changing the API, run `make docs-catalogs` from the repository root and commit the result in the same branch. CI regenerates it and fails when the committed copy differs.
- `content/docs/api/index.mdx` is the API section overview (auth, first request, pagination, errors, MCP pointer) at `/docs/api`. Endpoint tables belong in the generated `/docs/api/*` pages, not that MDX file. Root `meta.json` lists `api/index` then `...api` so the overview and OpenAPI tag groups are flattened under the API section once (do not also list bare `api`, or the folder nests and duplicates).

## MCP catalog docs

- Tools / prompts / resources pages render from the committed snapshot `src/lib/mcp-catalog.snapshot.json` (`src/lib/mcp-catalog.ts`). The docs build needs no network.
- The snapshot is generated from the MCP definitions in `web/lib/mcp/`. After changing MCP tools, prompts, or resources, run `make docs-catalogs` and commit the result. CI fails when the committed copy is out of date.

## Watcher CLI catalog

- [`content/docs/cli-reference.mdx`](content/docs/cli-reference.mdx) renders `<WatcherCliCatalog />` from the committed snapshot at `src/lib/cli-catalog.snapshot.json`.
- Regenerate it with `make py-watcher-cli-catalog docs-bundle-generate` (or `make docs-catalogs`, which also refreshes the other two snapshots) and commit the result. CI fails when it is out of date. A watcher version bump changes it too, because the snapshot records the version. The [MCP docs bundle](#mcp-docs-bundle) embeds this page, so it changes with it.
- Keep narrative caveats (interactive prompts, Windows-only service, examples) in the MDX; do not hand-maintain flag tables.
- Markdown / LLM export expands `WatcherCliCatalog` via `getLLMText` (`src/lib/cli-catalog-markdown.ts`), same placeholder pattern as the MCP catalogs.

The three `src/lib/*.snapshot.json` files are generated output, so Biome skips them. Never edit them by hand.

## MCP docs bundle

The Data Hub MCP server answers questions from a copy of these pages bundled into the web app, so each deployment answers from the docs that match its own code.

- `scripts/generate-docs-bundle.ts` writes the copy to `web/lib/mcp/docs/docs-bundle.snapshot.json`, using the same `getLLMText` output as `/docs/<path>.md`. It leaves out the generated API endpoint pages and the MCP tool, prompt, and resource catalogs.
- Regenerate it with `make docs-catalogs` (or `npm run docs-bundle:generate` here) after changing any page or the watcher CLI snapshot, and commit the result. CI fails when it is out of date. Never edit it by hand.
- The script loads the pages through `fumadocs-mdx/node`, which needs this package to be an ES module (`"type": "module"`), and runs under `tsx`. `scripts/stub-assets-loader.mjs` stubs image imports, which Node cannot load.
- The server returns a page in one tool result, so a page must stay under 75,000 characters (the longest today is about 18,000). A test fails above that, because Claude Code caps a tool result at 25,000 tokens. Split a page that grows past it.
- Give every heading a stable `[#id]` when other pages link to it. The server uses those IDs as section names, and agents quote them back.
- Search quality is covered by a list of real questions in `web/tests/unit/mcp-docs-search.test.ts`, plus questions the docs don't answer, which must come back flagged as weak matches. When a page is renamed or split, or a new page answers one of those questions, update the lists.

## AI-consumption surface

This site is intentionally public and indexable, and is itself built to be read by agents: `/llms.txt` (page index), `/llms-full.txt` (full corpus dump), and `/docs/<path>.md` (any page as raw Markdown, via content negotiation on `Accept: text/markdown`). The Data Hub MCP server serves the same pages through its `search_docs` and `read_doc` tools (see [MCP docs bundle](#mcp-docs-bundle)). When editing docs, keep pages self-contained enough that they still make sense pulled out of the nav and read as a flat Markdown file — that's how most AI clients will actually consume them.

## Checks

Run before pushing (`make docs-check` from the repository root runs all three, and `make docs-format` applies the formatter first):

```sh
npm run lint:check   # Ultracite (Biome) format + lint, read-only
npm run typecheck    # fumadocs-mdx codegen + next typegen + tsc --noEmit
npm run check:links  # page names, changelog links, and developer-doc links
```

`npm run typecheck` will fail on bad MDX (frontmatter, unclosed components) even if `next dev` doesn't complain, since `fumadocs-mdx` regenerates page types from `content/docs/`.

`npm run check:links` checks that the targets exist; it does not check `#heading` anchors. It covers:

- The `${DOCS_URL}/<page>` page names in `web/lib/docs.ts`.
- The `docs:` links in `web/content/changelog/*.md`.
- GitHub links in `content/docs/**/*.mdx` to files in this repository.
- Relative links inside `docs/developer/*.md`.

Renaming or deleting a page here can break the first two, so run it after changing page file names.

## Microfrontends

This site is deployed as a [Vercel Microfrontends](https://vercel.com/docs/microfrontends) child app mounted at `/docs` under the product web app's domain, so `next.config.mjs` wraps the app with `withMicrofrontends`. That wrapper reads the microfrontends config at build time — in `npm run typecheck`, `next build`, `next dev`, and the Vercel deploy — and throws `MicrofrontendsError` if it can't find it.

The config lives in one place: `web/microfrontends.json`, owned by the default app (the web app). `next.config.mjs` points the wrapper at it by setting `VC_MICROFRONTENDS_CONFIG` to that file, unless the variable is already set. The `dev` and `proxy` scripts in `package.json` use the same path. Do not add a copy of `microfrontends.json` here. Changing routing, fallbacks, or `packageName` means editing `web/microfrontends.json` only.

Reading a file outside `docs/site/` means the Vercel project's **Include source files outside of the Root Directory in the Build Step** setting must stay on. Production routing is still owned by the web app's deployed config; the file only feeds this app's own build (asset prefix and the local dev proxy).

## Deployment

The docs Vercel project (`data-hub-docs`) is connected to the `data-hub` repository with Root Directory `docs/site`, and its production branch is `production`. Merging to `staging` creates a preview; promoting `staging` to `production` publishes the site, at the same moment as the web app changes it describes.

`vercel.json` runs `scripts/vercel-ignore-build.sh`, which skips the build when nothing under `docs/site/` or `web/microfrontends.json` changed since the last deployment. The web app's project does the opposite for pushes that only change `docs/`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Docs site

This is the public docs site at https://datahub.arcadiascience.com/docs, a Fumadocs app on Next.js 16. Next.js 16 changed APIs that most training data predates, so read the guide in `docs/site/node_modules/next/dist/docs/` before you use a Next.js API you're unsure about. Run commands from `docs/site/`, or use the `make docs-*` targets from the repo root.

## Pages

- Pages live in `docs/site/content/docs/**/*.mdx`. Each folder's `meta.json` sets the page order, so edit it when you add or remove a page.
- Every page needs `title` and `description` in its frontmatter, and starts with an `<Audience>` tag naming who it is for.
- Use `<Callout type="info">` or `<Callout type="warn">`, `<Steps>` with `<Step>`, and `<Cards>` with `<Card>` for warnings and walkthroughs.
- Link to other pages as `/docs/<slug>#<id>`. Give a heading a stable `[#id]` when other pages link to it, because the MCP server uses those IDs as section names.
- Link to developer docs as `https://github.com/Arcadia-Science/data-hub/blob/production/docs/developer/<file>.md`. The link check fails on other branches and on broken links.
- Each page must make sense read alone as Markdown, because agents read pages through `/llms.txt`, `.md` URLs, and the MCP server.
- A test in `web/tests/unit/mcp-docs-search.test.ts` caps page length, so split a page that grows too long. When you rename or split a page, update that test's question lists.

## Generated pages

- `docs/site/content/docs/meta.json` lists `api/index` and then `...api`. Don't also list bare `api`, or the folder nests twice. Endpoint tables belong in the generated `/docs/api/*` pages, not in `docs/site/content/docs/api/index.mdx`.
- The flag tables in the CLI reference come from the CLI snapshot. Keep only narrative caveats in `docs/site/content/docs/cli-reference.mdx`.
- This package is `"type": "module"`, because `docs/site/scripts/generate-docs-bundle.ts` loads pages through `fumadocs-mdx/node`.

## Links and microfrontends

- `make docs-links` doesn't check `#anchors`. Run it after you rename a page, because `web/lib/docs.ts` and the `docs:` links in changelog entries point at page names.
- Don't add a copy of `microfrontends.json` here. `docs/site/next.config.mjs` points `VC_MICROFRONTENDS_CONFIG` at `web/microfrontends.json`, and a missing config throws `MicrofrontendsError` in typecheck, build, and dev.

Fumadocs docs: https://fumadocs.dev/llms.txt

Skill: `writing-guidelines` (vercel-labs/agent-skills), for reviewing the writing on a page.

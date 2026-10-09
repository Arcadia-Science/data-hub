# Docs over MCP

An assistant connected to Data Hub's MCP server can answer questions about Data Hub itself. Two tools, `search_docs` and `read_doc`, and a `datahub://docs/{page}` resource template serve the docs pages and the changelog. This page explains how they get their content, how search works, and what to update when you change them.

## Where the content comes from

Each deployment answers from the docs that match its own code, so the docs ship inside the web app instead of being fetched from the published site.

```text
docs/site/content/docs/*.mdx
        │  make docs-catalogs  (docs/site/scripts/generate-docs-bundle.ts)
        ▼
web/lib/mcp/docs/docs-bundle.snapshot.json   (committed, never edited by hand)
        │
        ├── web/lib/mcp/docs/bundle.ts    pages + changelog, split into sections
        ├── web/lib/mcp/docs/search.ts    MiniSearch index, built once per server
        └── web/lib/mcp/tools/docs.ts     search_docs and read_doc
```

- The generator uses the same `getLLMText` function as `/docs/<page>.md`, so the Markdown an agent reads matches what the site serves.
- It includes the hand-written pages, such as `cli-reference`, `mcp`, and `api` (the API overview). It leaves out the generated API endpoint pages and the MCP tool, prompt, and resource catalogs, because the client already receives the catalog when it connects.
- The `cli-reference` page includes the watcher version, so a watcher version bump changes the bundle. Run `make py-watcher-cli-catalog docs-bundle-generate` and commit both files.
- The changelog is read from `web/content/changelog/` at runtime, the same files the in-app changelog uses. Deployments get those files through `outputFileTracingIncludes` in `web/next.config.mjs`.
- `docs-lint.yml` regenerates the file and fails when the committed copy differs. After changing a docs page, run `make docs-catalogs` and commit the result.
- A change to the bundle is a change under `web/`, so the web app's Vercel project rebuilds for docs-only changes. That is intended: the deployed MCP server has to carry the new text.

## How the agent finds the right page

No tool returns all the docs at once. The flow is search, then read.

1. `search_docs(query)` returns up to five matching sections, with at most two from one page. Each has a page ID, a section ID, a short excerpt, and a link to cite.
2. `read_doc(page, section?)` returns one page, or one section of it, as Markdown. It also lists the page's section IDs. It accepts a docs URL or a `/docs/...` path as well as a page ID. For an unknown page ID, the error suggests the closest page IDs, allowing for typos and other forms of a word.
3. When no section matches most of the question, `search_docs` adds a hint: the results may not answer it, so the agent should say the docs don't cover the question and offer `send_feedback` about the gap. The hint also names any words of the question that appear nowhere in the docs.
4. When nothing matches at all, `search_docs` returns every docs page with its description, and the same hint to offer `send_feedback`.

Search ranks sections with [MiniSearch](https://lucaong.github.io/minisearch/). Headings and page titles count more than body text. Common question words and the product name are dropped, plurals are folded together, and long words tolerate a typo. Changelog entries are weighted lower so a short entry does not outrank the page that explains the feature. There are no embeddings, so there is no extra service or API key.

A section matches when it contains any one word of the question, so most questions return results even when the docs don't cover them. A section counts as an answer when it contains at least two thirds of the question's words, rounded up, and every word of the question appears somewhere in the docs. That rule decides when the hint in step 3 appears. Some uncovered questions still pass it, for example when every word appears on an unrelated page, so the `search_docs` description also tells the agent to judge the results itself.

Page IDs are the page's path under `docs/site/content/docs/` (`manage-tokens`, `mcp`), and changelog entries are `changelog/<file name>`. Section IDs are the `[#id]` after a heading, or the generated slug.

## Server instructions

`web/lib/mcp/instructions.ts` is sent to every client at connect time. Claude Code keeps only the first 2 KB, so a unit test (`tests/unit/mcp-instructions.test.ts`) fails above 2,048 bytes. Put the most important points first.

## Usage data

`mcp_docs_search` records how many sections answer the question by the rule above, in the same buckets as the in-app search, and `mcp_docs_read` records the page ID. The query text is never recorded. A rising share of searches in the `0` bucket shows where the docs have gaps.

## Tests

- `tests/unit/mcp-docs-search.test.ts` holds real questions, each with the page that should answer it. The page must be in the top three results, and the search must count at least one answer. It also holds questions the docs don't answer, which must get no answers. Add a question when someone reports a search that missed.
- `tests/unit/mcp-docs-markdown.test.ts` covers section splitting, page references, and page ID suggestions.
- `tests/mcp/mcp-protocol.test.ts` covers the tools and the resource template over the in-memory transport.
- `tests/integration/mcp.test.ts` calls both tools against the production build, which shows the docs bundle is compiled into the server. It can't show that the changelog files reach a deployment, because `next start` reads them from the source tree.

Adding the two tools took the tool count from 37 to 39. Pinned counts in `tests/mcp/mcp-catalog.test.ts`, `tests/mcp/mcp-protocol.test.ts`, and `tests/integration/mcp.test.ts` show that change in review.

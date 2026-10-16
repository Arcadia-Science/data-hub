# Docs and changelog over MCP

An assistant connected to Data Hub's MCP server can answer questions about Data Hub itself. Two tools, `search_docs` and `read_doc`, and a `datahub://docs/{page}` resource template serve the docs pages. A third tool, `search_changelog`, serves the changelog. This page explains how they get their content, how search works, and what to update when you change them.

## Where the content comes from

Each deployment answers from the docs and changelog that match its own code, so both ship inside the web app instead of being fetched from the published site.

```text
docs/site/content/docs/*.mdx
        │  make docs-catalogs  (docs/site/scripts/generate-docs-bundle.ts)
        ▼
web/lib/mcp/docs/docs-bundle.snapshot.json   (committed, never edited by hand)
        │
        ├── web/lib/mcp/docs/bundle.ts    pages, split into sections
        ├── web/lib/mcp/docs/search.ts    MiniSearch index, built once per server
        └── web/lib/mcp/tools/docs.ts     search_docs and read_doc

web/content/changelog/*.md   (read at runtime, the same files the in-app changelog uses)
        │
        ├── web/lib/changelog/entries.ts          parses and sorts the entries
        ├── web/lib/mcp/changelog/search.ts       MiniSearch index, built once per server
        └── web/lib/mcp/tools/changelog.ts        search_changelog
```

- The generator uses the same `getLLMText` function as `/docs/<page>.md`, so the Markdown an agent reads matches what the site serves.
- It includes the hand-written pages, such as `cli-reference`, `mcp`, and `api` (the API overview). It leaves out the generated API endpoint pages and the MCP tool, prompt, and resource catalogs, because the client already receives the catalog when it connects.
- The `cli-reference` page includes the watcher version, so a watcher version bump changes the bundle. Run `make py-watcher-cli-catalog docs-bundle-generate` and commit both files.
- Deployments get the changelog files through `outputFileTracingIncludes` in `web/next.config.mjs`.
- `docs-lint.yml` regenerates the docs bundle and fails when the committed copy differs. After changing a docs page, run `make docs-catalogs` and commit the result.
- A change to the bundle is a change under `web/`, so the web app's Vercel project rebuilds for docs-only changes. That is intended: the deployed MCP server has to carry the new text.

## How the agent finds the right page

No tool returns all the docs at once. The flow is search, then read.

1. `search_docs(query)` returns up to five matching sections, with at most two from one page. Each has a page ID, a section ID, a short excerpt, and a link to cite.
2. `read_doc(page, section?)` returns one page, or one section of it, as Markdown. It also lists the page's section IDs. It accepts a docs URL or a `/docs/...` path as well as a page ID. For an unknown page ID, the error suggests the closest page IDs, allowing for typos and other forms of a word. For a `changelog/...` ID, the error points to `search_changelog`.
3. When no section matches most of the question, `search_docs` adds a hint: the results may not answer it, so the agent should try `search_changelog` if the question is about a change, and otherwise say the docs don't cover the question and offer `send_feedback` about the gap. The hint also names any words of the question that appear nowhere in the docs.
4. When nothing matches at all, `search_docs` returns every docs page with its description, and the same hint.

Search ranks sections with [MiniSearch](https://lucaong.github.io/minisearch/). Headings and page titles count more than body text. Common question words and the product name are dropped, plurals are folded together, and long words tolerate a typo. The word handling lives in `web/lib/mcp/search-terms.ts` and is shared with the changelog index. There are no embeddings, so there is no extra service or API key.

A section matches when it contains any one word of the question, so most questions return results even when the docs don't cover them. A section counts as an answer when it contains at least two thirds of the question's words, rounded up, and every word of the question appears somewhere in the docs. That rule decides when the hint in step 3 appears. Some uncovered questions still pass it, for example when every word appears on an unrelated page, so the `search_docs` description also tells the agent to judge the results itself.

Page IDs are the page's path under `docs/site/content/docs/` (`manage-tokens`, `mcp`). Section IDs are the `[#id]` after a heading, or the generated slug.

## The changelog tool

`search_changelog(query?, dateFrom?, dateTo?, limit?)` answers "what changed this week", "what's new since October 1", and "when did X change". Questions about how to do something stay with `search_docs`.

- Without a `query`, it lists the entries in the date range, newest first. With one, it ranks them by how well they match, and the newer entry wins a tie.
- `dateFrom` and `dateTo` are calendar days, both included. They match the date in the entry's file name, which is the day the change merged into `staging`. An entry shows up in a deployment only after the change reaches it.
- `limit` defaults to 20 and is at most 50. Each result is a whole entry, because entries are short. `total` says how many entries matched, which is more than were returned when the limit cut the list. There is no offset, so an agent narrows the dates to see the rest.
- Each entry has a `url` that opens it in the in-app changelog window, and a `docsUrl` for the docs page that explains it, when the entry has one. See [Links to an entry](#links-to-an-entry).
- A query made only of filler words (`what changed recently`, `latest`) lists entries by date instead, because every entry describes a change. The words are in `FILLER_WORDS` in `web/lib/mcp/changelog/search.ts`.
- It uses the same two-thirds rule as `search_docs`. When no entry matches most of the question, the hint says so and gives the date the changelog starts, since a change from before then was never written up. It does not offer `send_feedback`, because a missing entry is not a docs gap. When nothing matches, the hint gives the dates the changelog covers and, for a query, suggests listing by date.
- It rejects a `dateFrom` or `dateTo` that is not a real YYYY-MM-DD day, a range that runs backwards, and a one-letter query.

### Links to an entry

`/?changelog=<entry id>` opens the changelog window with that entry expanded. `changelogEntryPath` in `web/lib/changelog/href.ts` builds the path from the same `changelogSearchParams` the window reads, so the tool, the Copy link button, and the window agree on the format.

- `ChangelogProvider` in `web/components/changelog/changelog-provider.tsx` owns the window for the whole signed-in layout, so the link works on any page. The sidebar can't hold it, because on a phone the sidebar only renders while it is open.
- Opening the window from the account menu doesn't touch the address. Closing a window opened by a link removes `?changelog`, replacing the history entry so Back and a refresh don't reopen it.
- A link to an entry the deployment doesn't have, such as a staging link opened in production before the promotion, opens the window as the menu would and removes the parameter.
- A link opens only the entry it names. Otherwise the entries with a New badge start open, except when every entry is new, as on a first visit, and then only the newest does. `initialExpandedIds` in `web/lib/changelog/expanded.ts` holds the rule.
- A person who is signed out loses the link when they sign in, as with every other link in the app.

## Server instructions

`web/lib/mcp/instructions.ts` is sent to every client at connect time. It routes how-to questions to `search_docs` and questions about what changed to `search_changelog`. Claude Code keeps only the first 2 KB, so a unit test (`tests/unit/mcp-instructions.test.ts`) fails above 2,048 bytes. Put the most important points first.

## Usage data

`mcp_docs_search` records how many sections answer the question by the rule above, in the same buckets as the in-app search, and `mcp_docs_read` records the page ID. The query text is never recorded. A rising share of searches in the `0` bucket shows where the docs have gaps. `search_changelog` has no event of its own. Every tool call is already counted by `mcp_tool_call`.

## Tests

- `tests/unit/mcp-docs-search.test.ts` holds real questions, each with the page that should answer it. The page must be in the top three results, and the search must count at least one answer. It also holds questions the docs don't answer, which must get no answers. Add a question when someone reports a search that missed.
- `tests/unit/mcp-changelog-search.test.ts` does the same for the changelog, and covers date ranges, ordering, the limit, filler words, and the size of the largest allowed result. If that last test fails, lower `MAX_LIMIT`.
- `tests/unit/changelog-links.test.ts` covers the link builder and which entries start open.
- `tests/unit/mcp-docs-markdown.test.ts` covers section splitting, page references, and page ID suggestions.
- `tests/mcp/mcp-protocol.test.ts` covers the tools and the resource template over the in-memory transport.
- `tests/integration/mcp.test.ts` calls the tools against the production build, which shows the docs bundle is compiled into the server. It can't show that the changelog files reach a deployment, because `next start` reads them from the source tree.

Adding `search_docs` and `read_doc` took the tool count from 37 to 39, and `search_changelog` made it 40. Pinned counts in `tests/mcp/mcp-catalog.test.ts`, `tests/mcp/mcp-protocol.test.ts`, and `tests/integration/mcp.test.ts` show that change in review.

---
name: Quick-preview text files from the run files table
overview: Add an eye icon to the run page's files table that opens a CSV, TSV, JSON, or other text file in a dialog, showing up to the first 1 MB, so people can inspect a file without downloading it.
ticket: ENG-1546
repo: data-hub
todos:
  - id: file-type-helper
    content: Add the previewable-file check and preview kind to web/lib/runs/run-file-types.ts, with unit tests
    status: completed
  - id: preview-loader
    content: Add web/lib/runs/file-preview.ts with the 1 MB ranged fetch, truncation, partial-row trimming, and parsing, with unit tests
    status: completed
  - id: export-table-view
    content: Export the paged CSV table view from colony-data-table.tsx so the dialog can reuse it
    status: completed
  - id: preview-dialog
    content: Build the preview dialog with Download and next/previous controls
    status: completed
  - id: table-wiring
    content: Add the eye icon to FileInfoCells and open the dialog from both the editable and read-only tables
    status: completed
  - id: analytics
    content: Add file_previewed to the analytics catalog and record it from the browser when a file is shown
    status: completed
  - id: changelog-docs
    content: Add a changelog entry, a line in browse-runs.mdx under Download files, and run make docs-catalogs
    status: completed
  - id: checks
    content: Run unit tests and make check, and check the dialog by hand against local seeded files
    status: completed
---

## Problem

The ticket asks: "It would be nice to be able to click on a CSV/JSON/any text in the table and quick-preview it in the browser. Currently, if I want to quickly inspect CSVs, I download, save, drag csv to text editor (3 clicks minimum)." The report came from an InstantRaman run page, on the second page of its files table.

Today the files table on the run page (`/instruments/[instrumentId]/runs/[runId]`) has no preview. `FileInfoCells` in `web/components/runs/run-files-table.tsx` shows the filename and a download icon linking to `/api/v1/files/{id}/download`. That route redirects to a signed S3 link that saves the file. The only in-page views of file contents are in the Report Data section (`web/components/runs/run-report-section.tsx`), which covers processed CSVs, images, PDFs and videos. They are not reachable from the table, and the section does not show raw text.

## Decisions

All decisions below come from the engineer interviewed for this ticket.

1. **Which files.** Preview files ending in `.csv`, `.tsv`, `.json`, `.txt`, `.log`, `.yaml` (and `.yml`), and `.md`. Also preview any file whose stored content type starts with `text/`, except HTML. The check is a helper in `web/lib/runs/run-file-types.ts`.
2. **How it looks.** A dialog on the page. CSV and TSV show as a table that reuses the `ColonyDataTable` view. JSON is pretty-printed. Everything else is monospace text.
3. **Size limit.** Fetch only the first 1 MB, using a `Range` header on the existing `?disposition=inline` download URL. When the file is bigger, show a "showing the first part of this file" notice. For CSV and TSV, drop the last partial row.
4. **How it opens.** An eye icon next to the download icon in `FileInfoCells`. It appears only for files that can be previewed, and only for the statuses that show the download icon. It works in both the editable and the read-only table.
5. **Dialog extras.** The dialog has a Download button and next/previous controls. Next/previous move only within the current page of the table, skip files that can't be previewed, and are disabled at the first and last previewable file on the page.
6. **Analytics.** Add a `file_previewed` event in `web/lib/analytics/track.ts` and record it when a preview opens.
7. **Tests.** Unit tests in `web/tests/unit/` for the new pure helpers: the previewable-file check, the size cap and truncation, and trimming the partial CSV row. No component tests, since the table has none today. Run `make check`.
8. **Scope and release.** Browser code only, with no new server endpoint. Add a changelog entry in `web/content/changelog/` and a line in `docs/site/content/docs/browse-runs.mdx` under "Download files". Run `make docs-catalogs` and commit the regenerated `web/lib/mcp/docs/docs-bundle.snapshot.json`.

## Approach

The browser fetches the file bytes itself through the existing download route, the same way the Report Data CSV tables do today in `createRestReportDataSource().fetchTableRows` (`web/lib/runs/rest-report-data-source.ts`). The route checks `files:read` and redirects to a signed S3 link. The S3 buckets already allow browser `GET` requests from any origin with any request header (`CorsConfiguration` in `infra/template.yaml`). The local dev mirror (`web/app/api/local-s3/[bucket]/[...key]/route.ts`) already answers `Range` requests with `206`. No server, database, or infrastructure change is needed.

### 1. Which files can be previewed (`web/lib/runs/run-file-types.ts`)

Add two helpers next to `isCsvFile` and the others. They follow the same rule: the content type or the extension, without regard to case.

- `filePreviewKind(file)` returns `"csv"`, `"tsv"`, `"json"`, `"text"`, or `null`.
  - Extension first: `.csv` gives `csv`, `.tsv` gives `tsv`, `.json` gives `json`, and `.txt`, `.log`, `.yaml`, `.yml`, `.md` give `text`.
  - Otherwise the stored content type: `text/csv` gives `csv`, `text/tab-separated-values` gives `tsv`, `application/json` gives `json`, and any other `text/*` gives `text`.
  - `text/html`, and files ending in `.html` or `.htm`, give `null`.
- `isPreviewableFile(file)` returns `filePreviewKind(file) !== null`.

The check uses the extension first because watcher uploads often store `binary/octet-stream` (see `contentTypeForDownload` in `web/lib/s3-local-mirror.ts`).

### 2. Loading and parsing a preview (new `web/lib/runs/file-preview.ts`)

These are pure helpers plus one fetch function. The browser can import them, and unit tests can cover them.

- `PREVIEW_BYTE_LIMIT`, set to 1 MiB.
- `fetchFilePreviewBytes(fileId, signal)`:
  - Calls `fetch` on `/api/v1/files/{id}/download?disposition=inline` with `Range: bytes=0-{PREVIEW_BYTE_LIMIT}`, which asks for one byte more than the limit.
  - Returns the bytes as a `Uint8Array`.
  - S3 does not expose `Content-Range` to the browser; the bucket's `ExposedHeaders` lists only `ETag` and `Content-Length`. So "the file is bigger than the limit" is detected by getting more than `PREVIEW_BYTE_LIMIT` bytes back, not by reading the total size.
  - If a server ignores the range and returns `200` with the whole file, the same check still works.
  - A response that is not OK throws, with the status in the message, matching `fetchTableRows`.
- `capPreviewBytes(bytes)` returns `{ bytes, truncated }`. It cuts to `PREVIEW_BYTE_LIMIT` and sets `truncated` when anything was cut.
- `decodePreviewText(bytes, truncated)` decodes as UTF-8 with `TextDecoder` (not fatal). When the file was cut off, it drops a trailing replacement character left by a character split at the cut.
- `dropPartialLastRow(text)` returns the text up to and including the last newline. It is used only for CSV and TSV when the file was cut off.
- `buildFilePreview(kind, text, truncated)` returns one of:
  - `{ kind: "table", rows }` for CSV and TSV. It parses with `csv-parse/browser/esm/sync`, using the same options as `fetchTableRows` (`columns: true`, `skip_empty_lines: true`, `trim: true`), plus `delimiter: "\t"` for TSV. If parsing throws, it falls back to text.
  - `{ kind: "text", text, pretty: true }` for JSON that parses. It is formatted with `JSON.stringify(value, null, 2)`. JSON that was cut off, or is not valid, falls back to the raw text, because a cut-off JSON file can never parse.
  - `{ kind: "text", text }` for everything else.

  The `truncated` flag is carried through so the dialog can show the notice.

The preview does not use `ReportDataSource.fetchTableRows`, because that reads and caches the whole file.

### 3. Reusing the CSV table view (`web/components/runs/colony-data-table.tsx`)

Export the existing `ColonyDataTableView` (rows, page, and `onPageChange`; 10 rows per page; right-aligned number columns) so the dialog can render CSV and TSV previews with it. `ColonyDataTable` itself is unchanged.

### 4. The preview dialog (new `web/components/runs/file-preview-dialog.tsx`)

- Built from `Dialog`, `DialogContent`, `DialogHeader` and `DialogTitle` in `web/components/ui/dialog.tsx`, like `AuntyWellDialog`.
- Props: the ordered list of previewable files on the current page, the open file's id, and `onOpenChange` and `onSelect` callbacks.
- Header: the filename in monospace and a Download button. The button is an `<a href="/api/v1/files/{id}/download">`, so it still counts as a download in the server's `file_downloaded` event.
- Body:
  - A `Skeleton` while loading.
  - An error panel with a Retry button, matching `ColonyDataTable`.
  - Otherwise `ColonyDataTableView` for tables, or a scrollable `<pre>` in monospace for text.
  - The text is rendered as React text, never as HTML.
  - When `truncated` is set, a notice above the content says "Showing the first part of this file." An empty file shows an empty-file message.
- Footer: Previous and Next buttons that move through the given list. They are disabled at the first and last entry. The table's own page is never changed.
- Loading:
  - The dialog caches a promise per file id while it is open, the way `AuntyWellDialog` caches curves, and evicts it on failure so Retry works.
  - A request id (or an `AbortController`) makes sure a slow response for an earlier file cannot replace the current one.
  - The cache is cleared when the dialog closes, so previews of up to 1 MB each do not pile up in memory.
  - The CSV table page resets to the first page when the file changes.

### 5. Opening it from the table (`web/components/runs/run-files-table.tsx`)

- `FileInfoCells` gets an `onPreview(fileId)` prop.
  - When `DOWNLOADABLE_STATUSES` includes the file's status and `isPreviewableFile(file)` is true, an `Eye` icon button (from `lucide-react`) appears just before the download icon, with the same muted styling.
  - It has an accessible label "Preview {filename}".
- A small shared hook or component in the same file is used by both `EditableRunFilesTable` and `ReadOnlyRunFilesTable`. It:
  - holds the open file id;
  - builds the list of previewable files on the page (same status and type rule as the icon, in table order);
  - renders `FilePreviewDialog`.
- The run page refreshes itself every few seconds while files are uploading or processing (`RunAutoRefreshProvider`), which re-renders the table rows.
  - The dialog is keyed by file id, so a refresh does not reload the preview.
  - If the open file drops off the page (for example, it was dismissed in another tab), the dialog closes.

### 6. Analytics

- `trackEvent` in `web/lib/analytics/track.ts` runs only on the server (it uses `next/headers` and `after`), so client components cannot call it.
- The root layout already mounts the Vercel Analytics browser script (`<Analytics />` from `@vercel/analytics/next` in `web/app/layout.tsx`). The installed `@vercel/analytics` package provides a browser `track` function.
- The plan:
  - Add `file_previewed: { category: string; kind: string }` to the `AnalyticsEvents` catalog in `track.ts`. `category` is raw or processed; `kind` is csv, tsv, json, or text. No filename or id is sent, per the catalog's rule.
  - Add a small client helper, `web/lib/analytics/track-client.ts`, that imports only the catalog type and calls `track` from `@vercel/analytics`. This keeps every event name in one catalog.
  - Call it when the dialog shows a file: when it opens, and when next/previous switches files.
- The browser event cannot carry `user_id` the way server events do through `surfaceEvent`. See Open questions.

### 7. Changelog and docs

- **Changelog:** add `web/content/changelog/YYYY-MM-DD-preview-text-files.md`, named for the day the pull request merges into `staging`. The build agent uses the build date and renames the file if the merge happens on a later day. Frontmatter: `title` and `docs: https://datahub.arcadiascience.com/docs/browse-runs#download-files`. The body says in a sentence or two that the eye icon in a run's files table previews CSV, TSV, JSON and other text files without downloading them, and that large files show the first 1 MB.
- **Docs:** in `docs/site/content/docs/browse-runs.mdx`, add a bullet to the list under "Download files" (`#download-files`) about previewing a text file with the eye icon, including the 1 MB limit.
- Run `make docs-catalogs` and commit the regenerated `web/lib/mcp/docs/docs-bundle.snapshot.json`. Run `make docs-links` to check the changelog's docs link.

## Risky parts

None.

- No login or permission change. The preview uses the existing `GET /api/v1/files/:fileId/download` route and its `files:read` check, unchanged.
- No database schema, migration, or infrastructure change. The existing S3 settings already allow these browser reads.
- No public API or MCP tool change. The route's documented `disposition=inline` parameter is used as it is, and the `Range` header goes straight to S3.
- No new or upgraded dependency. `csv-parse`, `@vercel/analytics` and `lucide-react` are already installed.

One possible deviation would change this. If the engineer wants `file_previewed` recorded on the server through `trackEvent` instead (see Open questions), the download route would need a new query parameter. That is a change to a documented public API. It would need an update to `web/lib/api/openapi/paths/files.ts`, a regenerated `docs/site/src/lib/openapi.snapshot.json`, and an integration test.

## Size

Small. The work adds one helper module, one dialog component, and small edits to the files table, the file-type helpers, and the analytics catalog, all in browser code. It also adds unit tests, a changelog entry, a docs line, and a regenerated docs bundle. Nothing on the server changes.

## Testing

**New unit tests** in `web/tests/unit/` (Vitest, Node environment, as with the existing suite):

- `run-file-types.test.ts`: extend it for `filePreviewKind` and `isPreviewableFile`. Cases:
  - each listed extension, including upper case (`.CSV`);
  - `binary/octet-stream` with a text extension;
  - `text/plain` with no known extension;
  - `text/html` and `.html` excluded;
  - images, PDFs, and binary types excluded.
- New `file-preview.test.ts`:
  - `capPreviewBytes` at, just under, and just over the limit;
  - `decodePreviewText` dropping a multibyte character split at the cut;
  - `dropPartialLastRow` with and without a trailing newline;
  - `buildFilePreview` for CSV, TSV, valid JSON (pretty-printed), cut-off JSON (raw text), invalid CSV (falls back to text), and plain text.
- `fetchFilePreviewBytes`, with `fetch` stubbed as in `rest-report-data-source.test.ts`. It must request the inline download URL with `Range: bytes=0-{PREVIEW_BYTE_LIMIT}` and throw on a response that is not OK.

There are no component tests, since the files table has none today.

**Checks:** `npm run test:unit` in `web/`, then `make check`, `make docs-links`, and `make docs-catalogs` with no diff left behind.

**Manual check** in local dev (`make dev`, seeded data, and `npm run db:process-fixtures` for processed CSVs):

- Open a run with CSV and JSON files. The eye icon appears only on text files with a downloadable status. The dialog shows a table for CSV and pretty-printed JSON. Next/previous skip files that can't be previewed and stop at the ends of the page. Download saves the file.
- Put a CSV larger than 1 MB in the local mirror. The notice appears, and the last row is complete.
- The icon also works on a deleted (read-only) run.

## Open questions

- **What the reporter needs.** Nobody checked with the reporter which file extensions their InstantRaman runs actually contain. The plan assumes the CSV files seen in the code, which decision 1 covers.
- **Where the analytics event is recorded.** Decision 6 puts `file_previewed` in `track.ts`, and decision 8 keeps the change in browser code. `trackEvent` can only run on the server, so the plan records the event with the browser `track` function from `@vercel/analytics` and keeps its type in the `track.ts` catalog. Two differences from server events follow: it carries no `user_id`, and ad blockers can drop it. The alternative is to have the download route record it when the preview fetch adds a parameter such as `preview=1`. That changes a public API route (see Risky parts). The plan assumes the browser approach unless an engineer says otherwise.
- **Character encoding.** Files are decoded as UTF-8. A file in another encoding, such as Latin-1 from an instrument PC, shows replacement characters for accented letters. The plan assumes this is acceptable for a quick preview.

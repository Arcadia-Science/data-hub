# MCP Apps (run report View)

Data Hub's MCP server serves the run report as an interactive HTML page, so a chat client that supports the MCP Apps extension renders the same report the website renders instead of rebuilding it from JSON.

MCP Apps ([SEP-1865](https://modelcontextprotocol.io/specification/2026-01-26/apps)) is an extension to the Model Context Protocol. The server publishes an HTML page at a `ui://` address, the client fetches that page and runs it inside a locked-down iframe, and the page asks the client to make tool calls on its behalf. Throughout this page, "host" means the chat client doing that work, and "View" means the HTML page.

The same React components render both surfaces. The web app feeds them over REST and the View feeds them over MCP tool calls.

## What the server publishes

- `ui://data-hub/run-report` is a resource whose body is one self-contained HTML file, served with the media type `text/html;profile=mcp-app`.
- `get_run_report` carries a pointer to that resource, so a host knows to render the page when the model calls the tool.
- `report_view_items` and `report_view_file_url` are two read-only tools the View calls to locate its own data. Both return short-lived S3 URLs; neither returns file contents.

Adding those two took the tool count from 32 to 34. Two tests pin that number so the change shows up in review: `web/tests/mcp/mcp-catalog.test.ts` and `web/tests/integration/mcp.test.ts`.

### Tool metadata

`runReportToolUiMeta` in `web/lib/mcp/ui-apps.ts` writes the resource pointer twice:

```ts
{
  ui: { resourceUri: "ui://data-hub/run-report", visibility: ["app"] },
  "ui/resourceUri": "ui://data-hub/run-report",
}
```

The nested `ui.resourceUri` is what the current spec asks for. The flat `ui/resourceUri` key is deprecated and is kept because some hosts still read it. `visibility` is `["model", "app"]` on `get_run_report` and `["app"]` on the two view tools.

## How a host renders a run report

1. The model calls `get_run_report` for an instrument and a run.
2. The host reads `_meta.ui.resourceUri` on that tool and fetches the resource at `ui://data-hub/run-report`.
3. The server returns the HTML plus a content security policy naming the S3 origins the page may load bytes from.
4. The host renders the HTML in a sandboxed iframe on an origin separate from its own.
5. The page sends `ui/initialize` to the host over `window.postMessage`, and the host replies with the current theme, display mode, container size, and its own capabilities.
6. The page sends `ui/notifications/initialized`, and the host pushes the `get_run_report` result into the page.
7. The page reads the instrument type, instrument ID, and run ID out of that result and renders the matching report.
8. Every later data fetch is a `tools/call` that the page asks the host to forward to the server.

Steps 5 and 6 happen inside `useApp` from `@modelcontextprotocol/ext-apps`. `web/mcp-apps/run-report/app.tsx` only supplies the callbacks (`ontoolresult`, `ontoolcancelled`, `onerror`).

## How the View fetches data

No file bytes pass through the server. Every tool returns a presigned S3 URL and the View reads the object itself, the same way the web app has always read them through the `/api/v1/files/:id/download` redirect. The server only ever runs the permission check and signs.

### Report items — images, PDFs, spectra, and videos

1. The View calls `report_view_items` with the instrument, run, item kind, and a window offset.
2. The server looks up the run by its instrument ID and run ID, then asks `getReportItemsPage` for one window of matching files.
3. The server signs a download URL for every file in that window and returns those URLs alongside the file IDs and filenames.
4. The View stores each URL in an in-memory cache keyed by file ID.
5. The carousel points an `<img>`, `<iframe>`, or `<video>` straight at the cached URL.

Windows are 50 items by default and 200 at most. The signed URLs deliberately leave out the filename so S3 does not add a `Content-Disposition: attachment` header, which would stop a PDF from rendering inside a nested iframe.

### CSV tables

1. A component asks the data source for every row of a file, by file ID.
2. The View resolves a URL for that ID, from cache or with one `report_view_file_url` call.
3. The View `fetch`es the URL, so the bytes go from S3 to the iframe without touching the server.
4. The View parses the text with `csv-parse` and caches the rows under the file ID.

This is the same code path the web app uses, so there is no row ceiling and no truncation to report. Raman spectra, Aunty curves, the colony table, and the plate-reader map all go through it.

### JSON artifacts

1. The View calls `report_view_file_url` with a filename suffix such as `_aunty_plate.json`.
2. The server finds the one active file on that run whose filename ends with the suffix and returns its ID, filename, and a signed URL.
3. The View `fetch`es the URL and parses the JSON.

Aunty needs two of these. `loadAuntyPlate` resolves `_aunty_plate.json`, reads it, and normalizes it with the shared `parseAuntyPlateJson`; then it resolves `_aunty_curves.csv` purely for the file ID, which it hands to the plate report so the well dialog can load curves as a table. A run with no curves file (an isothermal export) resolves to `null` and the dialog renders without a chart.

### Download URLs for files that never came through a window

`RunReportSection` renders files listed by `get_run_report`, which does not include download URLs. Those components ask the data source to resolve a URL by file ID, and `report_view_file_url` answers it in one call.

## One set of components, two data sources

The seven instrument renderers used to call `fetch("/api/v1/…")` directly, which only works inside Next.js. They now take a data source through React context, and each surface supplies its own.

`web/lib/runs/view-data-source.ts` defines the contract:

| Method | What it does |
| --- | --- |
| `fetchReportItems` | Returns one window of report items for a kind. |
| `fetchTableRows` | Returns every parsed row of a CSV, cached per file ID. |
| `resolveFileUrl` | Returns a URL for a file's bytes, possibly asynchronously. |
| `peekFileUrl` | Returns a URL synchronously if one is already known, so a component can paint during render. |
| `resolveFileBySuffix` | Finds one file by filename suffix. View only. |

Two implementations exist:

- `web/lib/runs/rest-report-data-source.ts` backs the web app. `resolveFileUrl` and `peekFileUrl` both return `/api/v1/files/{id}/download`, which 302-redirects the browser to S3. It does not implement `resolveFileBySuffix`, because the web app resolves artifacts on the server and passes them into the page as props.
- `web/mcp-apps/run-report/mcp-data-source.ts` backs the View. It calls tools to locate files and `fetch`es the bytes itself, keeping the same URL and row caches.

`fetchTableRows` returns the whole file rather than a page because every caller charts or indexes all of it, and both sources cache per file ID, so paging would only add round trips.

`peekFileUrl` exists because the MCP source is asynchronous. Calling `resolveFileUrl` during render would allocate a new Promise on every render, and using that Promise as an effect dependency caused a render loop during development. Only the effect in `useResolvedFileUrl`, keyed on the file ID, is allowed to call `resolveFileUrl`.

## What each instrument renders in the View

`InstrumentReport` in `web/mcp-apps/run-report/instrument-report.tsx` picks a renderer from the instrument type:

| Instrument type | Renderer |
| --- | --- |
| `gel_doc`, `hina_microscope` | `ImageCarouselReport` |
| `tape_station` | `PdfCarouselReport` |
| `dishcam` | `VideoCarouselReport` |
| `instant_raman` | `RamanReportSection` |
| `aunty` | `AuntyPlateReport` |
| `plate_reader` | `PlateMapGrid` / `PlateMapWithIndexSlider` |
| `generic`, `qpcr`, `epson_v700_scanner`, `fplc` | `RunReportSection` |

The carousel renderers remember which file the user had selected. The View writes the selected file ID to `localStorage` under `data-hub:run-report:{instrumentId}:{runId}`, and reads it back on the next load to anchor the first window on that file.

## Build

The View is a Vite + Tailwind app under `web/mcp-apps/`. `npm run build` in `web/` runs `mcp-apps:build` first, then `next build`. Next's output tracing includes `mcp-apps/dist/run-report.html` in the `/mcp/v1` function bundle.

```sh
cd web
npm run mcp-apps:build
```

`vite-plugin-singlefile` inlines all JavaScript and CSS into the HTML, so the output is one file with no external requests. It currently measures 1,307,852 bytes, or 352,722 bytes gzipped. Recharts and the shadcn component tree account for most of that.

Tailwind cannot see the shared components from the Vite root on its own, so `web/mcp-apps/run-report.css` names them explicitly:

```css
@import "../app/globals.css";

@source "../components";
@source "../hooks";
@source "../lib";
@source ".";
```

The built file is gitignored. Self-hosters and CI must run that step (or `npm run build`) so `resources/read` serves the real View. In development, a missing artifact falls back to a placeholder page and logs a warning. In production, a missing artifact throws.

## Local development

`make dev` / `next dev` does not rebuild the View on every save. After changing files under `web/mcp-apps/` or shared report components, re-run `npm run mcp-apps:build` (or use a one-off Vite watch if you are iterating on the View alone).

Browser-based hosts reach `/mcp/v1` from a different origin, so `web/lib/mcp/cors.ts` sends `Access-Control-Allow-Origin: *` on that route and answers preflight requests. The route authenticates with a Bearer token only and never sets `Access-Control-Allow-Credentials`, so a browser will not attach a session cookie to those requests.

`web/proxy.ts` also lets `/api/local-s3` through without a session, because the View loads file bytes from a cross-origin sandbox that has no cookie. That route returns 404 whenever `NODE_ENV` is `production` or `LOCAL_S3_MIRROR` is unset, so it cannot expose anything on a real deploy. GET and HEAD send the same `*` CORS headers as the S3 buckets; without them a `fetch` of a plate-reader CSV or Aunty JSON fails with "Failed to fetch" even though the file is public.

## Content security policy

The host builds the sandbox iframe's policy out of what the server declares on the resource, so the server has to name every origin the View loads bytes from. An origin it leaves out is an image, video, or PDF the View cannot display.

`runReportUiMeta` in `web/lib/mcp/ui-csp.ts` puts the same origin list in all three fields: `resourceDomains` for images and video, `frameDomains` for the nested PDF preview, and `connectDomains` for the `fetch` calls that read CSV and JSON bodies. The list is the raw-data and processed bucket origins, plus `authBaseURL`, `http://localhost:3000`, and `http://127.0.0.1:3000` outside production. It drops the S3 hosts entirely when `LOCAL_S3_MIRROR` is set, because the mirror serves bytes from the app's own origin.

Both buckets matter: a run's files live in the raw bucket or the processed one depending on the row's `s3_bucket`, and processed artifacts are most of what the report renders. That is why the deploy needs `S3_PROCESSED_BUCKET` set even though download URLs never read it. Archives are zips the View never renders, so they stay out. The `fetch` calls also need bucket-side CORS, which `infra/template.yaml` grants with a `*` GET rule — the sandbox origin is chosen by the host and cannot be allowlisted ahead of time.

The bucket origin comes from `s3BucketOrigin` in `web/lib/s3.ts`, which sits beside the `S3Client` so that setting `endpoint` or `forcePathStyle` on the client forces an update in the same file. Composing it as a string keeps `runReportUiMeta` synchronous, and that matters: `registerResource` attaches the policy to the `resources/list` entry and the `resources/read` body from the same call, and it cannot await anything before the listing.

## Serving the HTML

`web/lib/mcp/run-report-html.ts` reads the built file from disk on the first request and caches it in module memory. Before serving it, the function replaces the `%%DATA_HUB_ORIGIN%%` placeholder in the page's `<meta name="data-hub-origin">` tag with the deploy's own origin. The View reads that tag to build the "Open in Data Hub" link, which it hands to the host through `openLink` because the sandbox blocks popups.

## Limitations

- **App-only tools stay in `tools/list` for every client.** Hiding tools whose `visibility` excludes `"model"` is the host's job under the spec. `mcp-handler` builds a fresh server for each request and registers tools before `initialize`, so this server cannot vary its tool list per client.
- **Signed URLs expire after 15 minutes.** The View treats a cached URL as stale after 12 minutes, which is 80% of that window. Nothing schedules a timer, so the refresh happens on the next render rather than on a clock. A `<video preload="none">` that a user first plays more than 15 minutes after load will request an expired URL and fail without retrying.
- **A file whose URL cannot be resolved shows "Loading…" indefinitely.** `useResolvedFileUrl` sets its state to `null` on failure, and if it was already `null` React skips the re-render, so the effect never runs again. Files still awaiting upload land here, because `getReportItemsPage` excludes rows with no S3 key.
- **Production hosts need a second hostname for the sandbox iframe.** That is configured on the host side, not here.
- **Hosts may prefetch and cache the HTML.** Do not treat a single `resources/read` as the only time the View is fetched.

## Why this design

- **One HTML file with everything inlined.** A page split across separate JavaScript and CSS files would need those origins in `resourceDomains` and would add round trips inside a sandbox the host controls. Inlining trades a larger single response for a page that cannot fail halfway.
- **Tools return URLs, never file contents.** The sandbox has no session cookie and no token, so a `fetch` back to `/api/v1` would be unauthenticated — the permission check has to happen in a tool call the host authenticates. Signing a URL there and letting the iframe read S3 directly keeps that check while leaving the bytes off the server. Returning parsed rows instead would put an unbounded CSV through the function twice, once as `structuredContent` and once as pretty-printed text, and would cost Fast Origin Transfer the web app has never paid.
- **A data source interface rather than props.** A data source is a set of functions, and functions cannot cross the server-to-client boundary as props in the App Router. `RestReportDataSourceProvider` therefore builds the REST source inside a client component instead of receiving it from the server page.

## Related code

- Tool defs: `web/lib/mcp/tools/report-views.defs.ts`, `web/lib/mcp/tools/runs.defs.ts` (`get_run_report`)
- Tool handlers: `web/lib/mcp/tools/report-views.ts`
- Resource, CSP, and HTML loading: `web/lib/mcp/resources.ts`, `web/lib/mcp/ui-csp.ts`, `web/lib/mcp/run-report-html.ts`, `web/lib/mcp/ui-apps.ts`
- View entry: `web/mcp-apps/run-report/app.tsx`, `web/mcp-apps/run-report/main.tsx`
- Host bridge (theme, sizing, link interception): `web/mcp-apps/run-report/host-bridge.ts`
- Data sources: `web/lib/runs/view-data-source.ts`, `web/lib/runs/rest-report-data-source.ts`, `web/mcp-apps/run-report/mcp-data-source.ts`

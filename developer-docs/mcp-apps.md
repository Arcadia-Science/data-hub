# MCP Apps (run report View)

Data Hub's MCP server serves the run report as an interactive HTML page, so a chat client that supports the MCP Apps extension renders the same report the website renders instead of rebuilding it from JSON.

MCP Apps ([SEP-1865](https://modelcontextprotocol.io/specification/2026-01-26/apps)) is an extension to the Model Context Protocol. The server publishes an HTML page at a `ui://` address, the client fetches that page and runs it inside a locked-down iframe, and the page asks the client to make tool calls on its behalf. Throughout this page, "host" means the chat client doing that work, and "View" means the HTML page.

The same React components render both surfaces. The web app feeds them over REST and the View feeds them over MCP tool calls.

## What the server publishes

- `ui://data-hub/run-report` is a resource whose body is one self-contained HTML file, served with the media type `text/html;profile=mcp-app`.
- `get_run_report` carries a pointer to that resource, so a host knows to render the page when the model calls the tool.
- `report_view_items`, `report_view_table`, and `report_view_artifact` are three read-only tools the View calls to fetch its own data.

Adding those three took the tool count from 32 to 35. Two tests pin that number so the change shows up in review: `web/tests/mcp/mcp-catalog.test.ts` and `web/tests/integration/mcp.test.ts`.

### Tool metadata

`runReportToolUiMeta` in `web/lib/mcp/ui-apps.ts` writes the resource pointer twice:

```ts
{
  ui: { resourceUri: "ui://data-hub/run-report", visibility: ["app"] },
  "ui/resourceUri": "ui://data-hub/run-report",
}
```

The nested `ui.resourceUri` is what the current spec asks for. The flat `ui/resourceUri` key is deprecated and is kept because some hosts still read it. `visibility` is `["model", "app"]` on `get_run_report` and `["app"]` on the three view tools.

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

### Report items — images, PDFs, spectra, and videos

1. The View calls `report_view_items` with the instrument, run, item kind, and a window offset.
2. The server looks up the run by its instrument ID and run ID, then asks `getReportItemsPage` for one window of matching files.
3. The server signs a download URL for every file in that window and returns those URLs alongside the file IDs and filenames.
4. The View stores each URL in an in-memory cache keyed by file ID.
5. The carousel renders the selected item from that cache without another tool call.

Windows are 50 items by default and 200 at most. The signed URLs deliberately leave out the filename so S3 does not add a `Content-Disposition: attachment` header, which would stop a PDF from rendering inside a nested iframe.

### CSV tables

1. The View calls `report_view_table` with `full: true` the first time it needs a file.
2. The server streams the CSV out of S3 and parses it, stopping after 50,000 rows.
3. The server returns the column names, the rows, the number of rows it scanned, and a `truncated` flag that is true when it hit that ceiling.
4. The View caches the parsed rows and answers every later page request by slicing the cache.

One tool call per file replaces one HTTP request per visible page, so paging through a 20,000-row table does not become 100 round trips.

### JSON artifacts

1. The View calls `report_view_artifact` with a filename suffix such as `_aunty_plate.json`.
2. The server finds the one active file on that run whose filename ends with the suffix.
3. The server reads the object from S3, parses the JSON, and returns the parsed value.

Aunty plate data takes a separate branch inside the same tool. The server rebuilds it with `getAuntyPlateData`, which pairs the plate JSON with the file ID of the curves CSV so the View can load the curves as a table later.

### Download URLs for files that never came through a window

`RunReportSection` renders files listed by `get_run_report`, which does not include download URLs. Those components ask the data source to resolve a URL by file ID:

1. The View checks the URL cache for that file ID and returns the cached URL if it is still fresh.
2. On a miss, the View calls `report_view_items` once for each of the four item kinds with `anchor` set to the file ID and `limit` set to 1.
3. Whichever call matches puts a freshly signed URL into the cache.
4. The View reads the cache again and returns the URL, or throws if no kind matched.

The item kind is a required argument and filters the window, so there is no way to ask for one file without naming its kind. Four calls per uncached file is the cost of that.

## One set of components, two data sources

The seven instrument renderers used to call `fetch("/api/v1/…")` directly, which only works inside Next.js. They now take a data source through React context, and each surface supplies its own.

`web/lib/runs/view-data-source.ts` defines the contract:

| Method | What it does |
| --- | --- |
| `fetchReportItems` | Returns one window of report items for a kind. |
| `fetchTable` | Returns a page of parsed CSV rows for a file. |
| `fetchArtifact` | Returns a parsed JSON artifact by filename suffix. |
| `resolveFileUrl` | Returns a URL for a file's bytes, possibly asynchronously. |
| `peekFileUrl` | Returns a URL synchronously if one is already known, so a component can paint during render. |

Two implementations exist:

- `web/lib/runs/rest-report-data-source.ts` backs the web app. `resolveFileUrl` and `peekFileUrl` both return `/api/v1/files/{id}/download`, which 302-redirects the browser to S3, so file bytes still never pass through Vercel.
- `web/mcp-apps/run-report/mcp-data-source.ts` backs the View. Every method is a tool call through the host, and it keeps the URL and table caches described above.

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

`vite-plugin-singlefile` inlines all JavaScript and CSS into the HTML, so the output is one file with no external requests. It currently measures 1,278,570 bytes, or 345,760 bytes gzipped. Recharts and the shadcn component tree account for most of that.

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

`web/proxy.ts` also lets `/api/local-s3` through without a session, because the View loads file bytes from a cross-origin sandbox that has no cookie. That route returns 404 whenever `NODE_ENV` is `production` or `LOCAL_S3_MIRROR` is unset, so it cannot expose anything on a real deploy.

## Content security policy

The host builds the sandbox iframe's policy out of what the server declares on the resource, so the server has to name every origin the View loads bytes from. An origin it leaves out is an image, video, or PDF the View cannot display.

`runReportUiMeta` in `web/lib/mcp/ui-csp.ts` puts the raw-data and archives bucket origins in both `resourceDomains` (images and video) and `frameDomains` (the nested PDF preview), and adds `authBaseURL`, `http://localhost:3000`, and `http://127.0.0.1:3000` outside production. It leaves the S3 hosts out entirely when `LOCAL_S3_MIRROR` is set, because the mirror serves bytes from the app's own origin. `connectDomains` stays empty: every tool call travels through the host over `postMessage`, so the View never issues a cross-origin `fetch`, and the field is declared rather than omitted so that having a `csp` object cannot grant one.

The bucket origin comes from `s3BucketOrigin` in `web/lib/s3.ts`, which sits beside the `S3Client` so that setting `endpoint` or `forcePathStyle` on the client forces an update in the same file. Composing it as a string keeps `runReportUiMeta` synchronous, and that matters: `registerResource` attaches the policy to the `resources/list` entry and the `resources/read` body from the same call, and it cannot await anything before the listing.

## Serving the HTML

`web/lib/mcp/run-report-html.ts` reads the built file from disk on the first request and caches it in module memory. Before serving it, the function replaces the `%%DATA_HUB_ORIGIN%%` placeholder in the page's `<meta name="data-hub-origin">` tag with the deploy's own origin. The View reads that tag to build the "Open in Data Hub" link, which it hands to the host through `openLink` because the sandbox blocks popups.

## Limitations

- **App-only tools stay in `tools/list` for every client.** Hiding tools whose `visibility` excludes `"model"` is the host's job under the spec. `mcp-handler` builds a fresh server for each request and registers tools before `initialize`, so this server cannot vary its tool list per client.
- **Signed URLs expire after 15 minutes.** The View treats a cached URL as stale after 12 minutes, which is 80% of that window. Nothing schedules a timer, so the refresh happens on the next render rather than on a clock. A `<video preload="none">` that a user first plays more than 15 minutes after load will request an expired URL and fail without retrying.
- **A file whose URL cannot be resolved shows "Loading…" indefinitely.** `useResolvedFileUrl` sets its state to `null` on failure, and if it was already `null` React skips the re-render, so the effect never runs again. Files still awaiting upload land here, because `getReportItemsPage` excludes rows with no S3 key.
- **`truncated` is only surfaced for the plate reader.** `fetchAllTableRows` returns the flag, but the Aunty curves dialog, the Raman spectrum viewer, and the colony table all discard it, so a CSV over the 50,000-row scan cap renders as though it were complete.
- **Production hosts need a second hostname for the sandbox iframe.** That is configured on the host side, not here.
- **Hosts may prefetch and cache the HTML.** Do not treat a single `resources/read` as the only time the View is fetched.

## Why this design

- **One HTML file with everything inlined.** A page split across separate JavaScript and CSS files would need those origins in `resourceDomains` and would add round trips inside a sandbox the host controls. Inlining trades a larger single response for a page that cannot fail halfway.
- **Tool calls instead of direct HTTP from the View.** The sandbox has no session cookie and no token, so a `fetch` back to `/api/v1` would be unauthenticated. Routing every request through the host reuses the token the host already holds and keeps `connectDomains` empty.
- **`report_view_table` returns a whole file at once.** The alternative is one S3 GET per visible page, and the View pages through tables that instrument software writes in long format with tens of thousands of rows. The 50,000-row ceiling bounds the work; see the limitation above about the flag not reaching every caller.
- **A data source interface rather than props.** A data source is a set of functions, and functions cannot cross the server-to-client boundary as props in the App Router. `RestReportDataSourceProvider` therefore builds the REST source inside a client component instead of receiving it from the server page.

## Related code

- Tool defs: `web/lib/mcp/tools/report-views.defs.ts`, `web/lib/mcp/tools/runs.defs.ts` (`get_run_report`)
- Tool handlers: `web/lib/mcp/tools/report-views.ts`
- Resource, CSP, and HTML loading: `web/lib/mcp/resources.ts`, `web/lib/mcp/ui-csp.ts`, `web/lib/mcp/run-report-html.ts`, `web/lib/mcp/ui-apps.ts`
- View entry: `web/mcp-apps/run-report/app.tsx`, `web/mcp-apps/run-report/main.tsx`
- Host bridge (theme, sizing, link interception): `web/mcp-apps/run-report/host-bridge.ts`
- Data sources: `web/lib/runs/view-data-source.ts`, `web/lib/runs/rest-report-data-source.ts`, `web/mcp-apps/run-report/mcp-data-source.ts`

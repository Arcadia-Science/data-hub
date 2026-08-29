# MCP Apps (run report View)

Data Hub ships an [MCP Apps](https://modelcontextprotocol.io/specification/2026-01-26/apps) View so a host (today: Arcadia Chat) can render a run report inside a sandboxed iframe. The server advertises `ui://data-hub/run-report` and three app-only tools (`report_view_items`, `report_view_table`, `report_view_artifact`). Hosts must hide tools whose `visibility` does not include `"model"`.

Hosts may prefetch and cache the HTML resource. Do not treat a single `resources/read` as the only time the View is fetched.

## Build

The View is a Vite + Tailwind app under `web/mcp-apps/`. `npm run build` in `web/` runs `mcp-apps:build` first, then `next build`. Next's output tracing includes `mcp-apps/dist/run-report.html` in the `/mcp/v1` function bundle.

```sh
cd web
npm run mcp-apps:build
```

The built file is gitignored. Self-hosters and CI must run that step (or `npm run build`) so `resources/read` serves the real View. In development, a missing artifact falls back to a placeholder page and logs a warning. In production, a missing artifact throws.

## Local development

`make dev` / `next dev` does not rebuild the View on every save. After changing files under `web/mcp-apps/` or shared report components, re-run `npm run mcp-apps:build` (or use a one-off Vite watch if you are iterating on the View alone).

Presigned download URLs last 15 minutes. The View refreshes a cached URL after 80% of that window.

## Related code

- Tool defs: `web/lib/mcp/tools/report-views.defs.ts`, `web/lib/mcp/tools/runs.defs.ts` (`get_run_report`)
- Resource + CSP: `web/lib/mcp/resources.ts`, `web/lib/mcp/ui-csp.ts`, `web/lib/mcp/run-report-html.ts`
- View entry: `web/mcp-apps/run-report/app.tsx`

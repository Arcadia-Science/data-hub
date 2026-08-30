import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { authBaseURL } from "@/lib/auth";

export const DATA_HUB_ORIGIN_PLACEHOLDER = "%%DATA_HUB_ORIGIN%%";

const BUILT_HTML_PATH = path.join(
  process.cwd(),
  "mcp-apps/dist/run-report.html"
);

// Minimal MCP App so `resources/read` and basic-host work before the first
// Vite build. The real bundle overwrites this once `mcp-apps:build` runs.
export const HELLO_WORLD_RUN_REPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="data-hub-origin" content="${DATA_HUB_ORIGIN_PLACEHOLDER}" />
  <title>Data Hub run report</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 1rem; }
  </style>
</head>
<body>
  <h1>Data Hub run report</h1>
  <p id="status">Connecting…</p>
  <script>
    let nextId = 1;
    function sendRequest(method, params) {
      const id = nextId++;
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      return new Promise((resolve, reject) => {
        function listener(event) {
          if (event.data && event.data.id === id) {
            window.removeEventListener("message", listener);
            if (event.data.result) resolve(event.data.result);
            else reject(event.data.error);
          }
        }
        window.addEventListener("message", listener);
      });
    }
    (async () => {
      await sendRequest("ui/initialize", {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "data-hub-run-report", version: "0.0.0" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      });
      window.parent.postMessage(
        { jsonrpc: "2.0", method: "ui/notifications/initialized" },
        "*"
      );
      document.getElementById("status").textContent =
        "Hello from the Data Hub run report view.";
    })().catch((err) => {
      document.getElementById("status").textContent =
        "Failed to initialize: " + (err && err.message ? err.message : err);
    });
  </script>
</body>
</html>
`;

interface HtmlCache {
  mtimeMs: number;
  origin: string;
  rendered: string;
}

let cached: HtmlCache | null = null;

function withOrigin(html: string, origin: string): string {
  return html.replaceAll(DATA_HUB_ORIGIN_PLACEHOLDER, origin);
}

function artifactMtimeMs(): number {
  return existsSync(BUILT_HTML_PATH) ? statSync(BUILT_HTML_PATH).mtimeMs : 0;
}

export function resetRunReportHtmlCache(): void {
  cached = null;
}

export function loadRunReportHtml(): string {
  const origin = authBaseURL.replace(/\/$/, "");
  const mtimeMs = artifactMtimeMs();
  if (cached && cached.origin === origin && cached.mtimeMs === mtimeMs) {
    return cached.rendered;
  }

  if (!existsSync(BUILT_HTML_PATH)) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Run report View HTML is missing. Run `npm run mcp-apps:build` before `next build`."
      );
    }
    console.warn(
      "mcp-apps/dist/run-report.html is missing; serving the placeholder page."
    );
    return withOrigin(HELLO_WORLD_RUN_REPORT_HTML, origin);
  }

  const rendered = withOrigin(readFileSync(BUILT_HTML_PATH, "utf8"), origin);
  cached = { origin, mtimeMs, rendered };
  return rendered;
}

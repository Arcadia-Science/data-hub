import { existsSync, readFileSync } from "node:fs";
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

export function loadRunReportHtml(): string {
  const html = existsSync(BUILT_HTML_PATH)
    ? readFileSync(BUILT_HTML_PATH, "utf8")
    : HELLO_WORLD_RUN_REPORT_HTML;
  return html.replaceAll(
    DATA_HUB_ORIGIN_PLACEHOLDER,
    authBaseURL.replace(/\/$/, "")
  );
}

// Compares two MCP catalog documents and lists the changes that would break a
// client holding the older tool list. CI runs it on pull requests, with the
// base branch's `mcp-catalog.snapshot.json` and this branch's. Run it
// locally with `make mcp-catalog-check-compat` (or
// `npm run mcp-catalog:check-compat -- <base.json> <head.json>` here).
// Exits 0 when nothing breaks, 1 when something does, and 2 on bad arguments.
import { readFile } from "node:fs/promises";
import { findBreakingChanges } from "@/lib/mcp/catalog/compat";

const [basePath, headPath] = process.argv.slice(2);
if (!(basePath && headPath)) {
  console.error(
    "Usage: check-mcp-compat <base-catalog.json> <head-catalog.json>"
  );
  process.exit(2);
}

const base = JSON.parse(await readFile(basePath, "utf8"));
const head = JSON.parse(await readFile(headPath, "utf8"));
const findings = findBreakingChanges(base, head);

if (findings.length === 0) {
  console.log("No breaking MCP schema changes.");
  process.exit(0);
}

console.error(`Breaking MCP schema changes (${findings.length}):`);
for (const finding of findings) {
  console.error(`  - ${finding}`);
}
console.error(
  [
    "",
    "A client that connected before this change keeps the tool list it fetched, so these changes break it.",
    "Keep the old name or field working, mark it deprecated, and name its replacement and the earliest removal date in its description.",
    "If the change is intended, and its replacement has been in production for 14 days, add the `mcp-breaking-change` label to the pull request.",
    "See web/lib/mcp/AGENTS.md.",
  ].join("\n")
);
process.exit(1);

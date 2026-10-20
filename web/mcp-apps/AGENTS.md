# MCP Apps View

Read `docs/developer/mcp-apps.md` before you change the View.

`make dev` doesn't rebuild the View. After you change files here, run `npm run mcp-apps:build` in `web/`. Its output in `web/mcp-apps/dist/` is gitignored, and `npm run build` runs this step before `next build`.

MCP Apps docs: https://modelcontextprotocol.io/extensions/apps/overview.md

Skill: `add-app-to-server` (modelcontextprotocol/ext-apps), for adding UI to an MCP tool with `@modelcontextprotocol/ext-apps`.

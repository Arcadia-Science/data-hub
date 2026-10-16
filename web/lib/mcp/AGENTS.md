# MCP server

Read `docs/developer/mcp-docs.md` before you change the docs or changelog tools.

- Adding or removing a tool changes the tool count pinned in `web/tests/mcp/mcp-catalog.test.ts`, `web/tests/mcp/mcp-protocol.test.ts` (including `EXPECTED_TOOLS`), and `web/tests/integration/mcp.test.ts`. Update all three in the same commit.
- `*.output.ts` files use plain Zod. Don't import schemas that call `.openapi()`, such as `web/lib/api/openapi/schemas/runs.ts`, because those need registry side effects that unit tests skip.
- Pass a tool's `outputSchema` through whole, and don't wrap it in `z.object()`. Discriminated unions, such as the one `get_run_archive` returns, must stay intact.
- Keep `MCP_SERVER_INSTRUCTIONS` in `web/lib/mcp/instructions.ts` at or under 2 KB, with the most important points first. Claude Code keeps only the first 2 KB, and a unit test enforces the limit.
- MCP accepts OAuth access tokens only, not personal access tokens. Tools act as the signed-in person, so take user IDs from the auth context, never from tool arguments.

MCP docs: https://modelcontextprotocol.io/llms.txt

Skill: `mcp-builder` (anthropics/skills), for designing tools and writing their descriptions.

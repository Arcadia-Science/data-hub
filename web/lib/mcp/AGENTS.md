# MCP server

Read `docs/developer/mcp-docs.md` before you change the docs or changelog tools.

- Adding or removing a tool changes the tool count pinned in `web/tests/mcp/mcp-catalog.test.ts`, `web/tests/mcp/mcp-protocol.test.ts` (including `EXPECTED_TOOLS`), and `web/tests/integration/mcp.test.ts`. Update all three in the same commit.
- `*.output.ts` files use plain Zod. Don't import schemas that call `.openapi()`, such as `web/lib/api/openapi/schemas/runs.ts`, because those need registry side effects that unit tests skip.
- Pass a tool's `outputSchema` through whole, and don't wrap it in `z.object()`. Discriminated unions, such as the one `get_run_archive` returns, must stay intact. Build the registration config with `toolRegistrationConfig`, which opens the schema we advertise: no `additionalProperties: false`, and each string enum lists the known values plus any other string. Zod still validates results on the server. Code that calls `server.registerTool` itself, such as the feedback package, gets `withOpenOutputSchemas(server)` instead of `server`.
- Keep `MCP_SERVER_INSTRUCTIONS` in `web/lib/mcp/instructions.ts` at or under 2 KB, with the most important points first. Claude Code keeps only the first 2 KB, and a unit test enforces the limit.
- MCP accepts OAuth access tokens only, not personal access tokens. Tools act as the signed-in person, so take user IDs from the auth context, never from tool arguments.

## Changing a tool's schema

MCP clients keep the tool list they fetched when they connected and check every result against its output schema, so a schema change can break clients that still hold the old list. Output schemas are open, so you can add output fields and enum values freely.

- Renaming or removing a tool, a parameter, or a required output field breaks those clients. Keep the old one working for at least 14 days after its replacement reaches production. Mark it deprecated, and say in its description what replaces it and the earliest day it can be removed. The `deprecated()` helper in `web/lib/mcp/tools/instruments.output.ts` marks an output field.
- Other breaking changes: making an output field optional or nullable, adding an output type or union member, loosening an output limit, changing a `const`, and making an input parameter required or narrowing what it accepts (fewer types or enum values, or a tighter limit such as a lower `.max()`). `web/lib/mcp/catalog/compat.ts` lists the rules.
- CI compares the catalog with the base branch (`npm run mcp-catalog:check-compat`, or `make mcp-catalog-check-compat` locally) and fails on those changes. Once the 14 days have passed, add the `mcp-breaking-change` label to the pull request to skip the check. The label also skips it on a release pull request into `production`.
- Don't edit `docs/site/src/lib/mcp-catalog.snapshot.json` by hand. Run `make docs-catalogs`.

MCP docs: https://modelcontextprotocol.io/llms.txt

Skill: `mcp-builder` (anthropics/skills), for designing tools and writing their descriptions.

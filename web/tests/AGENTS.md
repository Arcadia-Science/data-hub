# Web tests

- Next.js returns a relative `Location` header for same-site redirects. Parse it with `new URL(location, getBaseUrl())`.
- Use your own test data, not the text of real changelog entries or docs pages, so content edits don't break tests.
- The MCP OAuth endpoints are rate-limited per IP, so call `getMcpAccessToken` once per user in `beforeAll`, not in each test.
- Reset the database with `resetDb()` from `web/tests/integration/helpers.ts`. It keeps the MCP signing keys and reseeds the single-row config tables.

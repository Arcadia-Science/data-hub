import { vi } from "vitest";

// Importing `@/lib/db` throws when `DATABASE_URL` is unset. CI sets that
// variable; local `make test` often does not. This suite never queries
// Postgres (see vitest.unit.config.ts), so a stub keeps the import graph
// loadable on either machine. A test file can still replace this mock.
vi.mock("@/lib/db", () => ({
  db: {},
}));

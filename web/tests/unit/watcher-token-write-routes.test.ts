import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A token that registered a watcher may write only to its own instrument (see
// `enforceWatcherTokenInstrument` in `web/lib/api/watchers.ts`). This fails
// when a route file that a token can write through calls none of the checks,
// so a new route can't quietly let one lab PC's token write to another
// instrument. It looks at whole files, so a file whose first write handler
// has the check passes even if a second one doesn't. A route that needs no
// check goes in EXEMPT, with the reason.
const API_DIR = path.resolve(import.meta.dirname, "../../app/api");

const WRITE_HANDLER =
  /export\s+(async\s+)?function\s+(POST|PATCH|PUT|DELETE)\b/;
const TOKEN_AUTH = /\bauthorize(Token)?\(/;
// `enforceWatcherBinding` is the per-watcher check on the watcher's own
// routes (heartbeat, config, events and the like).
const OWNERSHIP_CHECK =
  /\b(enforceWatcherTokenInstrument|enforceWatcherTokenFile|enforceWatcherTokenArchiveJob|refuseWatcherTokenAdmin|enforceWatcherBinding)\(/;

// Paths relative to `web/app/api`.
const EXEMPT: Record<string, string> = {
  [path.join("v1", "instruments", "route.ts")]:
    "Creating an instrument names no existing one, and the watcher's `init` calls it before it registers.",
  [path.join("v1", "watchers", "register", "route.ts")]:
    "Registering is how a token becomes a watcher's. Where a token that already has a watcher may register is ENG-2274.",
};

const TOKEN_WRITE_ROUTES = (
  readdirSync(API_DIR, { recursive: true }) as string[]
)
  .filter((file) => file.endsWith("route.ts"))
  .filter((file) => {
    const source = readFileSync(path.join(API_DIR, file), "utf8");
    return WRITE_HANDLER.test(source) && TOKEN_AUTH.test(source);
  })
  .sort();

describe("write routes a token can reach", () => {
  it("finds the routes the watcher calls", () => {
    expect(TOKEN_WRITE_ROUTES.length).toBeGreaterThanOrEqual(30);
    expect(TOKEN_WRITE_ROUTES).toContain(
      path.join(
        "v1",
        "instruments",
        "[instrumentId]",
        "runs",
        "[runId]",
        "request-upload-url",
        "route.ts"
      )
    );
  });

  it.each(
    TOKEN_WRITE_ROUTES.filter((file) => !(file in EXEMPT))
  )("%s limits a watcher's token", (file) => {
    const source = readFileSync(path.join(API_DIR, file), "utf8");
    expect(source).toMatch(OWNERSHIP_CHECK);
  });

  it("exempts only routes that still exist", () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(TOKEN_WRITE_ROUTES).toContain(file);
    }
  });
});

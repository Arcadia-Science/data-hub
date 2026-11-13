import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// On Vercel, Next.js decodes a route parameter twice, so a run ID has to be read
// with `readRunIdParam` (see `web/lib/api/run-id-param.ts`). This fails when a
// route, page, or layout under a `[runId]` folder takes the run ID straight from
// `params` instead.
const APP_DIR = path.resolve(import.meta.dirname, "../../app");

const RUN_ID_FILES = (readdirSync(APP_DIR, { recursive: true }) as string[])
  .filter(
    (file) =>
      file.includes("[runId]") &&
      /(route\.ts|page\.tsx|layout\.tsx)$/.test(file)
  )
  .sort();

// `const { instrumentId, runId: runIdParam } = await params;` gives
// "instrumentId, runId: runIdParam".
function paramDestructurings(source: string): string[] {
  return [...source.matchAll(/\{([^}]*)\}\s*=\s*await params\b/g)].map(
    (match) => match[1] ?? ""
  );
}

describe("files that read a run ID from the route", () => {
  it("covers the run routes and the run page", () => {
    expect(RUN_ID_FILES.length).toBeGreaterThanOrEqual(14);
    expect(RUN_ID_FILES).toContain(
      path.join(
        "(app)",
        "instruments",
        "[instrumentId]",
        "runs",
        "[runId]",
        "page.tsx"
      )
    );
    expect(
      RUN_ID_FILES.some((file) =>
        file.endsWith(`${path.sep}restore${path.sep}route.ts`)
      )
    ).toBe(true);
  });

  it.each(RUN_ID_FILES)("%s reads the run ID with readRunIdParam", (file) => {
    const source = readFileSync(path.join(APP_DIR, file), "utf8");

    expect(source).toMatch(
      /import\s*\{[^}]*\breadRunIdParam\b[^}]*\}\s*from\s*"@\/lib\/api\/run-id-param"/
    );

    // It never takes `runId` itself from the parameters.
    for (const names of paramDestructurings(source)) {
      expect(names).not.toMatch(/\brunId\b(?!\s*:)/);
    }
    expect(source).not.toMatch(
      /params\)?\.runId|params\[\s*["']runId["']\s*\]/
    );

    // Each time it takes the parameter apart under another name, the next
    // line passes that name to the helper (a page goes through `readRunId`).
    const renamed = paramDestructurings(source)
      .map((names) => /\brunId\s*:\s*(\w+)/.exec(names)?.[1])
      .filter((alias): alias is string => alias !== undefined);
    expect(renamed.length).toBeGreaterThan(0);
    for (const alias of renamed) {
      expect(source).toMatch(
        new RegExp(
          String.raw`const runId = (?:readRunIdParam\(request\.headers, ${alias}\)|await readRunId\(${alias}\));`
        )
      );
    }
    expect(source.match(/const runId = /g)?.length).toBe(renamed.length);
  });
});

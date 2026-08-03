/**
 * Regenerate `lib/db/auth-schema.ts` from the Better Auth CLI, then adapt
 * the plugin tables to this repo's conventions:
 *
 * - SQL table names stay snake_case (`oauth_client`, …) to match migration 0037
 * - Column names stay camelCase (`clientId`, …) — CLI `--` with adapter
 *   `camelCase: true`
 * - Core `user` / `session` / `account` / `verification` tables remain in
 *   `lib/db/schema.ts` (custom `is_admin`, existing FKs from app tables)
 * - Plural export names (`oauthClients`, …) match existing imports
 * - `jwks.alg` / `jwks.crv` are kept: the jwt plugin writes them at runtime
 *   even though they are absent from the CLI's typed schema
 *
 * Usage (from `web/`): `npm run db:generate-auth-schema`
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const cliOut = path.join(webRoot, "lib/db/auth-schema.cli.ts");
const target = path.join(webRoot, "lib/db/auth-schema.ts");

execFileSync(
  "npx",
  [
    "auth@latest",
    "generate",
    "--config",
    "lib/auth.ts",
    "--output",
    "lib/db/auth-schema.cli.ts",
    "--yes",
  ],
  { cwd: webRoot, stdio: "inherit" }
);

const cli = readFileSync(cliOut, "utf8");

function extractTable(source: string, exportName: string): string {
  const start = source.indexOf(`export const ${exportName} = pgTable(`);
  if (start < 0) {
    throw new Error(`CLI output missing export const ${exportName}`);
  }
  // Find the matching `);` that closes this pgTable call (handles nested parens).
  let i = start + `export const ${exportName} = pgTable`.length;
  let depth = 0;
  let inString: string | null = null;
  for (; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        // include trailing `;\n`
        let end = i + 1;
        if (source[end] === ";") {
          end++;
        }
        return source.slice(start, end);
      }
    }
  }
  throw new Error(`Unclosed pgTable for ${exportName}`);
}

const tableMap: Array<{
  cliName: string;
  exportName: string;
  sqlName: string;
}> = [
  { cliName: "jwks", exportName: "jwks", sqlName: "jwks" },
  {
    cliName: "oauthClient",
    exportName: "oauthClients",
    sqlName: "oauth_client",
  },
  {
    cliName: "oauthRefreshToken",
    exportName: "oauthRefreshTokens",
    sqlName: "oauth_refresh_token",
  },
  {
    cliName: "oauthAccessToken",
    exportName: "oauthAccessTokens",
    sqlName: "oauth_access_token",
  },
  {
    cliName: "oauthConsent",
    exportName: "oauthConsents",
    sqlName: "oauth_consent",
  },
];

let body = "";
for (const { cliName, exportName, sqlName } of tableMap) {
  let block = extractTable(cli, cliName);
  block = block.replace(
    `export const ${cliName} = pgTable(`,
    `export const ${exportName} = pgTable(`
  );
  // CLI camelCase mode emits the model name as the SQL table name; rewrite
  // multi-word oauth tables to the snake_case names already in Postgres.
  block = block.replace(`pgTable(\n  "${cliName}"`, `pgTable(\n  "${sqlName}"`);
  block = block.replace(`pgTable("${cliName}"`, `pgTable("${sqlName}"`);

  // Point FKs at the app schema's plural tables instead of CLI `user`/`session`.
  block = block.replaceAll("() => user.id", "() => users.id");
  block = block.replaceAll("() => session.id", "() => sessions.id");
  block = block.replaceAll("() => oauthClient.", "() => oauthClients.");
  block = block.replaceAll(
    "() => oauthRefreshToken.",
    "() => oauthRefreshTokens."
  );

  // Prefer date-mode timestamps to match `lib/db/schema.ts`.
  block = block.replace(
    /timestamp\("([^"]+)"\)/g,
    'timestamp("$1", { mode: "date" })'
  );

  if (exportName === "jwks") {
    // JWT plugin persists alg/crv on create; CLI typed schema omits them.
    block = block.replace(
      `expiresAt: timestamp("expiresAt", { mode: "date" }),
});`,
      `expiresAt: timestamp("expiresAt", { mode: "date" }),
  // Runtime columns written by the jwt plugin (not in CLI typed schema).
  alg: text("alg"),
  crv: text("crv"),
});`
    );
  }

  body += `${block}\n\n`;
}

const header = `/**
 * Better Auth JWT + \`@better-auth/oauth-provider\` tables.
 *
 * DO NOT hand-edit field lists — regenerate:
 *
 *   npm run db:generate-auth-schema
 *
 * That runs \`npx auth@latest generate\` (requires \`export default\` on
 * \`lib/auth.ts\` and drizzleAdapter \`camelCase: true\`) and adapts the
 * plugin tables for this repo (snake_case SQL table names, plural exports,
 * FKs into \`schema.ts\` users/sessions, plus jwks alg/crv).
 */
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sessions, users } from "./schema";

`;

writeFileSync(target, `${header}${body.trimEnd()}\n`);
unlinkSync(cliOut);
console.log(`Wrote ${path.relative(webRoot, target)}`);

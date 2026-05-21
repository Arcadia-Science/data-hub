// Safety gate for destructive database scripts (reset / seed / reseed).
//
// These scripts wipe and repopulate the schema, so we refuse to run unless
// `DATABASE_URL` points at the canonical local Postgres instance. This
// prevents accidentally pointing a script at staging/prod by leaking
// `DATABASE_URL` from the shell, a `.env.production`, Vercel `env pull`,
// etc.

const EXPECTED_DATABASE_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/data-hub-local";

export function assertLocalDatabaseUrl(scriptName: string): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error(
      `${scriptName}: DATABASE_URL is not set. Add it to web/.env or export it before running this script.`
    );
    console.error(`Expected: ${EXPECTED_DATABASE_URL}`);
    process.exit(1);
  }

  if (databaseUrl !== EXPECTED_DATABASE_URL) {
    console.error(
      `${scriptName}: refusing to run against a non-local database.`
    );
    console.error(`  Expected DATABASE_URL: ${EXPECTED_DATABASE_URL}`);
    console.error(`  Actual   DATABASE_URL: ${redact(databaseUrl)}`);
    console.error(
      "  This script is destructive and may only target the local dev Postgres."
    );
    process.exit(1);
  }

  return databaseUrl;
}

// Hide the password before echoing the URL back to the terminal in case
// the operator screen-shares the output.
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

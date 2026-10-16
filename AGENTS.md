# AGENTS.md

Data Hub collects files from lab instrument PCs (`watcher/`), processes them in AWS Lambda (`lambda/`), and serves them through a Next.js web app, REST API, and MCP server (`web/`). Developer docs start at `docs/developer/README.md`.

## Commits and pull requests

Keep sensitive information from internal environments (production, staging, or a coworker's machine) out of commit messages, pull request titles and bodies, review comments, and committed files. That includes:

- Credentials and secrets: personal access tokens (`dhub_…`), `AUTH_SECRET`, AWS keys and session tokens, database passwords, and webhook secrets.
- Pre-signed or authenticated URLs, such as S3 download links or anything with `X-Amz-Security-Token` or signature query parameters.
- Identifiers from internal environments: instrument IDs, run IDs, file IDs, and real filenames from those runs.
- Raw output from internal MCP tools, API responses, or logs that contains any of the above.
- `.env` contents or other gitignored config.

Public docs URLs, redacted error messages, and synthetic fixtures are safe. To describe a production incident, summarize the failure mode.

## Changelog

- A user-visible change to the web app, file processing, the API, or AI assistant behavior needs an entry in `web/content/changelog/` in the same branch.
- Name the file `YYYY-MM-DD-short-slug.md` with today's date, and rename it if the pull request merges into `staging` on a later day. The tests for `web/lib/changelog/parse.ts` check the name and frontmatter.
- If the change needs a new watcher version, the entry names that version.
- Tests, docs, CI, dependency updates, infrastructure, and watcher-only releases don't get entries.

## Generated snapshots

- After you change the REST API, MCP tools, prompts, or resources, the watcher CLI or version, a page in `docs/site/content/docs/`, or a dependency in a `package.json` or lockfile, run `make docs-catalogs` and commit every `*.snapshot.json` it changes. Dependency upgrades count because they can change the generated schemas.
- Never edit a `*.snapshot.json` file by hand. CI regenerates each one and fails when the committed copy differs.

## Docs

- The docs site deploys from `production`, so change the docs in the same branch as the feature.
- To learn how Data Hub behaves for users, read `docs/site/content/docs/` first. The published site at https://datahub.arcadiascience.com/docs shows what is live on `production`.

## Testing

Before you say a change is done:

- Run `make check`. It rewrites files to fix formatting, so review the diff afterward.
- Run the unit tests for each package you touched: `make fe-test-unit` for `web/` and `make py-test-unit` for the Python packages.
- If the change touches API routes, the database schema, or the watcher-to-server protocol, also run `make fe-test-integration` or `make py-test-integration`. Both run `next build` into `web/.next`, so stop `make dev` first.
- Check UI changes in the running app. `web/AGENTS.md` says how.
- Make sure a new test fails without your change by breaking the code once.
- CI runs everything else.

## Before you push

- Once the code is final, reread every comment, docs line, and changelog sentence you wrote and check it against the code.
- After you rename or move a file, search for the old path in imports, the `Makefile`, `package.json` scripts, `.github/workflows/`, and the docs.

## Python

Shipped Python in `lambda/`, `watcher/`, and `packages/shared/` must run on Python 3.12, because the Lambda image and lab PCs use 3.12. Local development uses 3.13 from `.python-version`. Run Python tools through `uv run`.

## Skills

- When an `AGENTS.md` names a skill, use it if it is installed. Otherwise load it for the session with `npx skills use <source> --skill <name>`, or with `npx skills use <pinned URL>` when the `AGENTS.md` gives a pinned URL.
- Ask before you install a skill that no `AGENTS.md` names, and never pass `-y`.
- When a skill's advice conflicts with an `AGENTS.md` rule, follow the `AGENTS.md`.
- `ultracite` (haydenbleasel/ultracite): fixing lint and format errors in `web/` and `docs/site/`.

## Cursor Cloud specific instructions

In a Cursor Cloud VM, read `docs/developer/cursor-cloud.md` before you run anything. Postgres may be missing or stopped, and `web/.env` may be missing.

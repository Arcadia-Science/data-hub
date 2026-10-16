# Cursor Cloud

Notes for Cursor Cloud agents and for whoever maintains the Cloud environment. A Cloud VM can run the web app, the REST API, and PostgreSQL end to end with no external credentials. The Python packages run through their tests and the local S3 mirror, so no AWS access is needed. For the general local workflow, see [Local development](local-development.md).

## PostgreSQL

The tests and the seed scripts expect PostgreSQL at `127.0.0.1:5432`, with a `postgres` user whose password is `postgres`. They use two databases: `data-hub-local` for `make dev`, and `data_hub_test` for the integration tests, which create it themselves if it's missing.

If PostgreSQL is installed but not running, which is the usual state right after a VM boots, start it:

```sh
sudo service postgresql start
```

If PostgreSQL isn't installed, install it, start it, then set the password and create the dev database:

```sh
sudo apt-get update
sudo apt-get install -y postgresql
sudo service postgresql start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb data-hub-local
```

`pg_isready -h 127.0.0.1` reports whether it's accepting connections.

## Environment file

`web/.env` is gitignored, and `make dev` and the seed scripts need it. If it's missing, create it from the "Minimal `.env`" block in [Local development](local-development.md#minimal-env).

## Node.js and Python

- Use Node.js 24 with npm 11. nvm selects it by default in a login shell. `npm ci` against the committed lockfile fails under npm 10, so don't downgrade.
- Python is managed by `uv`, with the version pinned in `.python-version`. If `uv` is missing, install it with `curl -LsSf https://astral.sh/uv/install.sh | sh`, then run `uv sync --all-packages`.
- `make check` covers the docs site, which has its own dependencies. Run `npm ci` in `docs/site/` before the first `make check`.

## Seeding, signing in, and tests

- `make db-reseed` resets the database, pushes the schema, and seeds sample data. It prints a personal access token for the dev user. It skips fixture processing unless `make dev` is running; [Local development](local-development.md) explains how to run that step afterward.
- Sign in at `/login` with "Sign in (dev)" as `alice@example.com`.
- The integration tests build into `web/.next`, which a running `make dev` also uses, so stop the dev server before you run them. See [Testing](testing.md).

## Environment setup in the Cursor dashboard

Agents have had to install PostgreSQL and `uv` by hand on some VMs. Putting both in the environment's install script removes that step. Cursor runs the install script when it builds the environment and keeps the resulting disk, but not running processes, so PostgreSQL also needs a start command.

Install script:

```sh
command -v psql >/dev/null || (sudo apt-get update && sudo apt-get install -y postgresql)
command -v uv >/dev/null || (curl -LsSf https://astral.sh/uv/install.sh | sh)
sudo service postgresql start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb data-hub-local 2>/dev/null || true
(cd web && npm ci) && (cd docs/site && npm ci) && uv sync --all-packages
```

Start command:

```sh
sudo service postgresql start
```

See [Cursor's Cloud Agent setup docs](https://cursor.com/docs/cloud-agent/setup) for where these settings live.

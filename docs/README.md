# Docs

Data Hub documentation is split by who is reading it.

| Folder | Audience | Format | Published |
| --- | --- | --- | --- |
| [`site/`](site/README.md) | Lab operators, admins, and integrators: installing a watcher, setting up an instrument, managing tokens, security, and the API, MCP, and watcher CLI reference. | MDX pages in a Fumadocs/Next.js app. | <https://datahub.arcadiascience.com/docs> |
| [`developer/`](developer/README.md) | People contributing to or self-hosting Data Hub: architecture, local setup, conventions, CI, and the deployment runbooks. | Plain Markdown, read on GitHub. | Not published. The site does not render it. |

The site only reads `site/content/docs/`, so nothing in `developer/` can appear on it. To send a site reader to a developer doc, link to it on GitHub, for example `https://github.com/Arcadia-Science/data-hub/blob/production/docs/developer/lambda.md`. `make docs-links` fails on a broken link.

## Common tasks

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `make docs-dev` | Start the docs site locally. Run `npm ci` in `docs/site/` first. |
| `make docs-catalogs` | Regenerate the API, MCP, and watcher CLI snapshots the site renders its reference pages from. Run it after changing the REST API, the MCP tools, or the watcher CLI, and commit the result. |
| `make docs-check` | Format, lint, type check, and check links. |
| `make docs-links` | Check links between the docs, the web app (`web/lib/docs.ts`), and the changelog. |

The docs site deploys from the `production` branch, so a docs change goes live when `staging` is promoted, together with the feature it describes. See [CI and deployment](developer/ci-and-deployment.md#docs-site) for the workflows and the Vercel project settings.

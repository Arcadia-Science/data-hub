# Developer docs

Documentation for developing and self-hosting Data Hub itself, including
deploying the web app and AWS infrastructure (see
[First-time deployment](first-time-deployment.md)). User, operator, and admin
documentation (installing a watcher, adding an instrument, managing tokens)
lives on the [docs site](https://datahub.arcadiascience.com/docs) instead —
see the root [README](../README.md#getting-started) for that split.

- [Getting started](getting-started.md) — development setup, environment variables, running locally
- [Local development](local-development.md) — zero-credential dev workflow for the web app + API + database (no watcher / Lambda needed)
- [Architecture](architecture.md) — system overview, data flow, and design decisions
- [Testing](testing.md) — per-package test frameworks, the shared test-server fixture, S3 mocking
- [Watcher](watcher.md) — CLI commands, configuration, run detection, upload modes
- [Lambda](lambda.md) — processing pipeline, supported instruments, adding new instruments
- [Shared library](shared-library.md) — module reference for `data-hub-shared`
- [First-time deployment](first-time-deployment.md) — step-by-step self-hosting guide: database, Vercel web app, and AWS S3 + Lambda
- [CI and deployment](ci-and-deployment.md) — GitHub Actions workflows, branch strategy, and how CI redeploys each piece
- [Run archives](run-archives.md) — "Download all" flow, cache/dedup model, and on-call runbook
- [Conventions](conventions.md) — S3 key layout, instrument IDs, code style, environments

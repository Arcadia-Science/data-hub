# Architecture Overview

Read this document first — it describes the overall system and how the parts fit together. All other requirements documents assume familiarity with this context.

## System Components

1. A **relational database** (PostgreSQL) that stores instruments, watchers, files, instrument runs, and report data
2. A **REST API** (Next.js API routes) consumed by the file upload service, the Lambda function, and the web UI
3. A **Next.js web application** for browsing and viewing instrument data
4. A **file upload service** (watcher) — a Python CLI tool on lab PCs that monitors directories and uploads files to S3
5. A **Lambda function** that processes each file landing in S3 — extracting metadata and (for instruments that require it) parsing structured data — and writes per-file results to the database via the API

## System Diagram

```
  Instrument PC                    AWS                          Data Hub App
┌───────────────┐          ┌──────────────────┐           ┌──────────────────────┐
│ File Upload   │  upload  │  S3 Raw Bucket   │  trigger  │  Next.js + Database  │
│ Service       │─────────►│                  │──────────►│                      │
│ (watcher)     │          │                  │           │  Lambda writes to DB │
│               │          │  S3 Processed    │◄──────────│  Web UI reads from   │
│               │──────────┼──────────────────┼──────────►│  DB + S3             │
│  heartbeat,   │  API     │                  │           │                      │
│  registration │  calls   │                  │           │                      │
└───────────────┘          └──────────────────┘           └──────────────────────┘
```

## Data Flow

1. The **file upload service** (watcher) on a lab PC detects new files and uploads them to S3. It also registers itself, syncs config, and sends heartbeats to the Data Hub API.
   - **Manual mode alternative:** For instruments generating large data, the watcher detects files and reports instrument runs to the API *without* uploading. A user selects individual files (or entire runs) for upload via the web UI, and the watcher uploads each file on demand, signaling completion per file.
2. **S3 triggers** invoke the Lambda function when a file lands in the raw data bucket.
3. The **Lambda function** processes each file individually: it downloads the file from S3, extracts instrument-specific metadata, and (for instruments that require it) parses structured data from the file. Results are written to the database via the API on a per-file basis. If no instrument run exists for the file, the Lambda auto-creates one.
4. The **web application** reads from the database and generates pre-signed S3 URLs for file access.
5. **Run-level processing** (e.g., analyses that aggregate data across multiple files) is triggered manually from the web UI, not automatically by the Lambda's S3 event. The API invokes the Lambda or a dedicated processor with the run context.

## Requirements Documents

Each document below is scoped to one agent's workstream. Read [INTEGRATION_CONSTRAINTS.md](./INTEGRATION_CONSTRAINTS.md) alongside the relevant workstream doc.

### Foundation (read first)

| Document | Scope |
|---|---|
| [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) | PostgreSQL schema via Drizzle ORM — tables, relationships, indexes |
| [INTEGRATION_CONSTRAINTS.md](./INTEGRATION_CONSTRAINTS.md) | S3 conventions, secrets, instrument identity, non-functional requirements |
| [MONOREPO_STRUCTURE.md](./MONOREPO_STRUCTURE.md) | Repository layout, uv workspaces, deployment boundaries, CI/CD |

### API

| Document | Scope |
|---|---|
| [api/AUTHENTICATION.md](./api/AUTHENTICATION.md) | Auth.js + personal access tokens + middleware |
| [api/INSTRUMENTS.md](./api/INSTRUMENTS.md) | Instrument CRUD endpoints + admin page |
| [api/WATCHERS.md](./api/WATCHERS.md) | Watcher registration, config, heartbeat, events endpoints |
| [api/INSTRUMENT_RUNS.md](./api/INSTRUMENT_RUNS.md) | Run CRUD, per-file processing, files, upload queue, analysis |

### Web Application

| Document | Scope |
|---|---|
| [web/DASHBOARD.md](./web/DASHBOARD.md) | Dashboard page + shared UI patterns + technology stack |
| [web/INSTRUMENT_PAGES.md](./web/INSTRUMENT_PAGES.md) | Instrument detail, run detail, watchers pages |
| [web/SETTINGS.md](./web/SETTINGS.md) | Token management page + sign-in page |

### Lambda

| Document | Scope |
|---|---|
| [lambda/MIGRATION.md](./lambda/MIGRATION.md) | Per-file processing model, refactoring Lambda to write to the API instead of Notion |

### Watcher (File Upload Service)

| Document | Scope |
|---|---|
| [watcher/CONFIG_AND_VALIDATION.md](./watcher/CONFIG_AND_VALIDATION.md) | YAML schema + Pydantic models + validation rules |
| [watcher/CLI.md](./watcher/CLI.md) | Click commands + init wizard |
| [watcher/API_CLIENT.md](./watcher/API_CLIENT.md) | API client, config sync, heartbeat, event reporting |
| [watcher/FILE_MONITORING.md](./watcher/FILE_MONITORING.md) | Watchdog, stability detection, deduplication, run detection |
| [watcher/UPLOAD.md](./watcher/UPLOAD.md) | S3 upload logic + retry + logging |
| [watcher/WINDOWS_SERVICE.md](./watcher/WINDOWS_SERVICE.md) | pywin32 service wrapper |

## Dependency Graph

An agent picking up any workstream should read this document and [INTEGRATION_CONSTRAINTS.md](./INTEGRATION_CONSTRAINTS.md) first. Beyond that:

| Workstream | Also needs |
|---|---|
| Database schema | Nothing else |
| API Authentication | Database schema |
| API Instruments | Database schema, Authentication |
| API Watchers | Database schema, Authentication |
| API Instrument Runs | Database schema, Authentication |
| Web Dashboard | API Instrument Runs |
| Web Instrument Pages | API Instrument Runs, API Instruments, API Watchers |
| Web Settings | API Authentication |
| Lambda Migration | Database schema, API Instrument Runs |
| Watcher Config | Nothing else |
| Watcher CLI | Watcher Config, Watcher API Client |
| Watcher API Client | Watcher Config |
| Watcher File Monitoring | Watcher Config, Watcher Upload |
| Watcher Upload | Watcher Config |
| Watcher Windows Service | Watcher CLI |

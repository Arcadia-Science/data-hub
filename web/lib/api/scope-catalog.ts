import type { Scope } from "@/lib/api/scopes";

// Human-facing copy for each scope, consumed by the token modal's per-scope
// tooltips and the live "this token can…" summary. `destructive` drives the
// warning styling so admins can spot delete/reset grants at a glance.
export interface ScopeMeta {
  description: string;
  destructive: boolean;
  label: string;
}

export const SCOPE_METADATA: Record<Scope, ScopeMeta> = {
  "instruments:read": {
    label: "View instruments",
    description: "Read instruments, dashboard status, and file patterns.",
    destructive: false,
  },
  "instruments:write": {
    label: "Manage instruments",
    description: "Create instruments and edit their configuration.",
    destructive: false,
  },
  "runs:read": {
    label: "View runs",
    description:
      "Read and search runs, their files, comments, and attributions.",
    destructive: false,
  },
  "runs:create": {
    label: "Create runs",
    description: "Create run records.",
    destructive: false,
  },
  "runs:update": {
    label: "Edit runs",
    description: "Update run metadata.",
    destructive: false,
  },
  "runs:delete": {
    label: "Delete runs",
    description: "Soft-delete and restore runs.",
    destructive: true,
  },
  "runs:reprocess": {
    label: "Reprocess runs",
    description: "Re-run the processing workflow for a run.",
    destructive: true,
  },
  "runs:upload": {
    label: "Upload to runs",
    description: "Request presigned S3 URLs to upload files to a run.",
    destructive: false,
  },
  "runs:attribute": {
    label: "Claim runs",
    description: "Claim or unclaim runs on your own behalf.",
    destructive: false,
  },
  "runs:comment": {
    label: "Comment on runs",
    description: "Add, edit, and delete run comments.",
    destructive: false,
  },
  "files:read": {
    label: "View files",
    description: "Read file metadata and download files and run archives.",
    destructive: false,
  },
  "files:create": {
    label: "Create files",
    description: "Register file records against a run.",
    destructive: false,
  },
  "files:update": {
    label: "Edit files",
    description: "Update file metadata and upload state.",
    destructive: false,
  },
  "files:delete": {
    label: "Delete files",
    description: "Delete files.",
    destructive: true,
  },
  "files:reprocess": {
    label: "Reprocess files",
    description: "Re-run the processing workflow for a file.",
    destructive: true,
  },
  "watchers:read": {
    label: "View watchers",
    description: "Read watcher status, heartbeats, and upload queues.",
    destructive: false,
  },
  "watchers:report": {
    label: "Report as watcher",
    description: "Register, heartbeat, send events, and push watcher config.",
    destructive: false,
  },
  "watchers:admin": {
    label: "Administer watchers",
    description: "Delete watchers.",
    destructive: true,
  },
  "archive-jobs:read": {
    label: "View archive jobs",
    description: "Read run-archive job status.",
    destructive: false,
  },
  "archive-jobs:write": {
    label: "Update archive jobs",
    description: "Update run-archive job status (Lambda callback).",
    destructive: false,
  },
};

export interface ScopePreset {
  description: string;
  id: string;
  label: string;
  scopes: Scope[];
}

// Curated starting points offered above the granular grid. Machine presets
// (Watcher, Lambda) mirror the exact endpoints those agents call so a token
// minted from them is already least-privilege; MCP mirrors the scopes the
// MCP tools check, giving a member an MCP-client surface analogous to the
// web UI. Custom (no preset) leaves the grid untouched for fine-tuning.
export const SCOPE_PRESETS: ScopePreset[] = [
  {
    id: "read-only",
    label: "Read-only",
    description: "View everything, change nothing.",
    scopes: [
      "instruments:read",
      "runs:read",
      "files:read",
      "watchers:read",
      "archive-jobs:read",
    ],
  },
  {
    id: "mcp",
    label: "MCP",
    description:
      "For an MCP client — browse, download, claim, comment, reprocess, delete/restore runs, request uploads, and dismiss pending files, like the web UI.",
    scopes: [
      "instruments:read",
      "runs:read",
      "runs:attribute",
      "runs:comment",
      "runs:reprocess",
      "runs:delete",
      "runs:upload",
      "files:read",
      "files:reprocess",
      "files:delete",
      "watchers:read",
    ],
  },
  {
    id: "watcher",
    label: "Watcher",
    description: "For a watcher agent reporting runs and uploads.",
    scopes: [
      "instruments:read",
      "instruments:write",
      "watchers:read",
      "watchers:report",
      "runs:create",
      "runs:update",
      "runs:upload",
      "files:update",
    ],
  },
  {
    id: "lambda",
    label: "Lambda",
    description: "For the processing Lambda writing runs and file results.",
    scopes: [
      "runs:create",
      "runs:update",
      "files:create",
      "files:update",
      "archive-jobs:write",
    ],
  },
];

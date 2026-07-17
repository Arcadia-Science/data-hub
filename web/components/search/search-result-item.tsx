"use client";

import {
  Activity,
  Cpu,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  type LucideIcon,
  MessageSquare,
} from "lucide-react";
import { InstrumentStatusBadge } from "@/components/instruments/instrument-status-badge";
import { Highlight } from "@/components/search/highlight";
import { UserAvatar } from "@/components/user-avatar";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type {
  SearchCommentResult,
  SearchFileResult,
  SearchInstrumentResult,
  SearchRunResult,
  SearchUserResult,
} from "@/lib/api/search";
import { cn, formatBytes, formatRelativeTime, toInitials } from "@/lib/utils";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "nd2",
]);
const SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "json",
  "xml",
  "log",
  "yaml",
  "yml",
]);

// Maps a filename to a type-appropriate glyph, falling back to a generic file
// icon for unmapped extensions.
function iconForFilename(filename: string): LucideIcon {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(ext)) {
    return ImageIcon;
  }
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return FileSpreadsheet;
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return FileText;
  }
  return FileIcon;
}

function ResultRowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

// Shared row scaffold: leading glyph/avatar, a flexible text column, and an
// optional right-hand stat. `leading` is a slot so user rows can pass an
// avatar without a boolean mode on the shell.
function ResultRowShell({
  leading,
  children,
  stat,
}: {
  leading: React.ReactNode;
  children: React.ReactNode;
  stat?: React.ReactNode;
}) {
  return (
    <>
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      {stat == null ? null : (
        <div className="ml-auto shrink-0 whitespace-nowrap pl-2 text-muted-foreground text-xs">
          {stat}
        </div>
      )}
    </>
  );
}

function pluralRuns(count: number): string {
  return `${count} total ${count === 1 ? "run" : "runs"}`;
}

export function SearchRunRow({
  result,
  query,
}: {
  result: SearchRunResult;
  query: string;
}) {
  const when = result.acquiredAt ?? result.createdAt;
  return (
    <ResultRowShell
      leading={<ResultRowIcon icon={Activity} />}
      stat={`${result.fileCount} ${result.fileCount === 1 ? "file" : "files"} · ${formatBytes(result.totalSizeBytes)}`}
    >
      <span className="block truncate font-medium font-mono text-sm">
        <Highlight query={query} text={result.runId} />
      </span>
      <span className="block truncate text-muted-foreground text-xs">
        <Highlight query={query} text={result.instrumentName} /> ·{" "}
        {formatRelativeTime(when)}
      </span>
      {result.matchReason === "file" && result.matchedFilename ? (
        <span className="block truncate text-muted-foreground text-xs">
          Contains{" "}
          <span className="font-mono">
            <Highlight query={query} text={result.matchedFilename} />
          </span>
        </span>
      ) : null}
    </ResultRowShell>
  );
}

export function SearchFileRow({
  result,
  query,
}: {
  result: SearchFileResult;
  query: string;
}) {
  return (
    <ResultRowShell
      leading={<ResultRowIcon icon={iconForFilename(result.filename)} />}
      stat={formatBytes(result.sizeBytes)}
    >
      <span className="block truncate font-medium font-mono text-sm">
        <Highlight query={query} text={result.filename} />
      </span>
      <span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
        <span className="truncate">{result.instrumentName}</span>
        <span aria-hidden="true">›</span>
        <span className="truncate font-mono">{result.runId}</span>
      </span>
    </ResultRowShell>
  );
}

export function SearchInstrumentRow({
  result,
  query,
}: {
  result: SearchInstrumentResult;
  query: string;
}) {
  return (
    <ResultRowShell
      leading={<ResultRowIcon icon={Cpu} />}
      stat={
        // Lifecycle badge for `pending`/`inactive`, watcher badge otherwise
        // (mirrors the instruments table).
        result.status === "active" ? (
          <WatcherStatusBadge
            lastOnlineAt={
              result.lastWatcherHeartbeatAt
                ? new Date(result.lastWatcherHeartbeatAt)
                : null
            }
            status={result.watcherStatus}
          />
        ) : (
          <InstrumentStatusBadge status={result.status} />
        )
      }
    >
      <span className={cn("block truncate font-medium text-sm")}>
        <Highlight query={query} text={result.displayName} />
      </span>
      <span className="block truncate text-muted-foreground text-xs">
        {result.matchReason === "pattern" && result.matchedPattern ? (
          <>
            Matches pattern{" "}
            <span className="font-mono">
              <Highlight query={query} text={result.matchedPattern} />
            </span>{" "}
            · {pluralRuns(result.runCount)}
          </>
        ) : (
          pluralRuns(result.runCount)
        )}
      </span>
    </ResultRowShell>
  );
}

export function SearchUserRow({
  result,
  query,
}: {
  result: SearchUserResult;
  query: string;
}) {
  const title = result.name ?? result.email ?? "Unknown";
  return (
    <ResultRowShell
      leading={
        <UserAvatar
          size="sm"
          user={{
            userId: result.id,
            displayName: title,
            initials: toInitials(title),
            avatarUrl: result.image,
          }}
        />
      }
    >
      <span className="block truncate font-medium text-sm">
        <Highlight query={query} text={title} />
      </span>
      {result.email && result.name ? (
        <span className="block truncate text-muted-foreground text-xs">
          <Highlight query={query} text={result.email} />
        </span>
      ) : null}
    </ResultRowShell>
  );
}

export function SearchCommentRow({
  result,
  query,
}: {
  result: SearchCommentResult;
  query: string;
}) {
  return (
    <ResultRowShell
      leading={<ResultRowIcon icon={MessageSquare} />}
      stat={formatRelativeTime(result.createdAt)}
    >
      <span className="block truncate font-medium text-sm">
        <Highlight query={query} text={result.bodyPreview} />
      </span>
      <span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
        <span className="truncate">{result.userName}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">{result.instrumentName}</span>
        <span aria-hidden="true">›</span>
        <span className="truncate font-mono">{result.runId}</span>
      </span>
    </ResultRowShell>
  );
}

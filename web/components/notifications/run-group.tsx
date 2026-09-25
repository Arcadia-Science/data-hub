"use client";

import {
  Activity,
  ChevronDown,
  FlaskConical,
  Image as ImageIcon,
  type LucideIcon,
  Microscope,
  Radar,
  ScanLine,
  TestTube,
  Thermometer,
  TriangleAlert,
  Video,
} from "lucide-react";
import Link from "next/link";
import { createContext, type ReactNode, use, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { formatTime } from "@/lib/date";
import type { InstrumentType } from "@/lib/db/schema";
import {
  RUN_GROUP_VISIBLE_LIMIT,
  type RunGroupEntry,
} from "@/lib/notifications/group-feed";
import {
  formatRunFailureLine,
  formatRunFileLine,
  formatRunGroupSummary,
} from "@/lib/notifications/run-row-copy";
import type { NotificationItem } from "@/lib/notifications/types";
import { cn, formatRelativeTime } from "@/lib/utils";

// Compound grouped-run row for the bell. Expansion and the 5-row cutoff live
// in the provider so Header / Runs / ShowMore share one state object without
// boolean layout props on a single mega-row.

const INSTRUMENT_TYPE_ICON: Record<InstrumentType, LucideIcon> = {
  generic: FlaskConical,
  plate_reader: Activity,
  gel_doc: ImageIcon,
  qpcr: TestTube,
  tape_station: Microscope,
  hina_microscope: Microscope,
  epson_v700_scanner: ScanLine,
  instant_raman: Radar,
  fplc: FlaskConical,
  dishcam: Video,
  aunty: Thermometer,
};

type AnchoredRun = RunGroupEntry["runs"][number];

interface RunGroupContextValue {
  actions: {
    activateRun: (notificationId: string) => void;
    navigate: () => void;
    revealAll: () => void;
    setOpen: (open: boolean) => void;
  };
  state: {
    group: RunGroupEntry;
    open: boolean;
    showAll: boolean;
  };
}

const RunGroupContext = createContext<RunGroupContextValue | null>(null);

function useRunGroup(): RunGroupContextValue {
  const ctx = use(RunGroupContext);
  if (!ctx) {
    throw new Error("RunGroup pieces must render inside RunGroup.Provider");
  }
  return ctx;
}

function notificationHref(n: AnchoredRun): string {
  return `/instruments/${encodeURIComponent(
    n.instrumentId
  )}/runs/${encodeURIComponent(n.runDisplayId)}`;
}

function occurredAt(n: NotificationItem): Date {
  return new Date(n.runAcquiredAt ?? n.createdAt);
}

function RunGroupProvider({
  group,
  onActivate,
  onNavigate,
  children,
}: {
  group: RunGroupEntry;
  onActivate: (notificationId: string) => void;
  onNavigate?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  return (
    <RunGroupContext
      value={{
        state: { group, open, showAll },
        actions: {
          setOpen,
          revealAll: () => setShowAll(true),
          activateRun: onActivate,
          navigate: () => onNavigate?.(),
        },
      }}
    >
      {children}
    </RunGroupContext>
  );
}

function RunGroupFrame({ children }: { children: ReactNode }) {
  const {
    state: { open },
    actions: { setOpen },
  } = useRunGroup();

  return (
    <li className="border-border border-b last:border-b-0">
      <Collapsible onOpenChange={setOpen} open={open}>
        {children}
      </Collapsible>
    </li>
  );
}

function RunGroupHeader() {
  const {
    state: { group, open },
  } = useRunGroup();
  const Icon = INSTRUMENT_TYPE_ICON[group.instrumentType];
  const unreadCount = group.runs.filter((r) => r.readAt === null).length;
  const summary = formatRunGroupSummary(group.runs.length, unreadCount);

  return (
    <CollapsibleTrigger
      aria-label={
        open
          ? `Collapse ${summary} on ${group.instrumentDisplayName}`
          : `Expand ${summary} on ${group.instrumentDisplayName}`
      }
      className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300"
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-semibold text-sm leading-snug">
            {group.instrumentDisplayName}
          </span>
          <span
            className="mt-0.5 block text-muted-foreground text-xs"
            suppressHydrationWarning
          >
            {summary} · {formatRelativeTime(group.latestCreatedAt)}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </span>
    </CollapsibleTrigger>
  );
}

function RunGroupBody({ children }: { children: ReactNode }) {
  return (
    <CollapsibleContent>
      <ul className="flex flex-col gap-1.5 px-4 pb-3">{children}</ul>
    </CollapsibleContent>
  );
}

function RunGroupRuns() {
  const {
    state: { group, showAll },
  } = useRunGroup();
  const visible = showAll
    ? group.runs
    : group.runs.slice(0, RUN_GROUP_VISIBLE_LIMIT);

  return (
    <>
      {visible.map((run) =>
        (run.filesFailed ?? 0) > 0 ? (
          <FailedGroupedRun key={run.id} run={run} />
        ) : (
          <GroupedRun key={run.id} run={run} />
        )
      )}
    </>
  );
}

function RunGroupShowMore() {
  const {
    state: { group, showAll },
    actions: { revealAll },
  } = useRunGroup();
  const hidden = group.runs.length - RUN_GROUP_VISIBLE_LIMIT;
  if (showAll || hidden <= 0) {
    return null;
  }

  return (
    <li>
      <button
        className="flex w-full cursor-pointer items-center justify-center rounded-lg py-1.5 text-muted-foreground text-xs hover:bg-foreground/10 hover:text-foreground"
        onClick={revealAll}
        type="button"
      >
        Show {hidden} more
      </button>
    </li>
  );
}

function GroupedRunLink({
  run,
  children,
}: {
  run: AnchoredRun;
  children: ReactNode;
}) {
  const { actions } = useRunGroup();
  const unread = run.readAt === null;

  return (
    <li>
      <Link
        className="flex min-h-12 items-start rounded-lg py-1.5 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/50"
        href={notificationHref(run)}
        onClick={() => {
          if (unread) {
            actions.activateRun(run.id);
          }
          actions.navigate();
        }}
      >
        {children}
      </Link>
    </li>
  );
}

function StatusGutter({ children }: { children?: ReactNode }) {
  return (
    <span className="flex w-[33px] shrink-0 justify-center pt-1">
      {children}
    </span>
  );
}

function UnreadDot() {
  return (
    <span
      aria-hidden
      className="mt-0.5 inline-block size-2 rounded-full bg-blue-500"
    />
  );
}

function UnreadRunName({ children }: { children: ReactNode }) {
  return (
    <span className="wrap-break-word block font-medium font-mono text-[13.5px] text-foreground leading-snug">
      {children}
    </span>
  );
}

function ReadRunName({ children }: { children: ReactNode }) {
  return (
    <span className="wrap-break-word block font-mono text-[13.5px] text-foreground leading-snug">
      {children}
    </span>
  );
}

function RunDetail({ children }: { children: ReactNode }) {
  return (
    <span
      className="mt-0.5 block text-[11.5px] text-muted-foreground leading-snug"
      suppressHydrationWarning
    >
      {children}
    </span>
  );
}

function GroupedRun({ run }: { run: AnchoredRun }) {
  const unread = run.readAt === null;
  const fileLine = formatRunFileLine(run.fileCount ?? 0, 0);

  return (
    <GroupedRunLink run={run}>
      <StatusGutter>{unread ? <UnreadDot /> : null}</StatusGutter>
      <span className="min-w-0 flex-1 pr-3">
        {unread ? (
          <UnreadRunName>{run.runDisplayId}</UnreadRunName>
        ) : (
          <ReadRunName>{run.runDisplayId}</ReadRunName>
        )}
        <RunDetail>
          {fileLine} · {formatTime(occurredAt(run))}
        </RunDetail>
      </span>
    </GroupedRunLink>
  );
}

function FailedGroupedRun({ run }: { run: AnchoredRun }) {
  const unread = run.readAt === null;
  const fileCount = run.fileCount ?? 0;
  const filesFailed = run.filesFailed ?? 0;
  const fileLine = formatRunFileLine(fileCount, filesFailed);

  return (
    <GroupedRunLink run={run}>
      <StatusGutter>{unread ? <UnreadDot /> : null}</StatusGutter>
      <span className="min-w-0 flex-1 pr-3">
        {unread ? (
          <UnreadRunName>{run.runDisplayId}</UnreadRunName>
        ) : (
          <ReadRunName>{run.runDisplayId}</ReadRunName>
        )}
        <RunDetail>
          {fileLine} · {formatTime(occurredAt(run))}
        </RunDetail>
        <span className="mt-1 flex items-start gap-1 text-[11.5px] text-destructive leading-snug">
          <TriangleAlert aria-hidden className="mt-px size-3 shrink-0" />
          <span>
            {formatRunFailureLine(fileCount, filesFailed)}{" "}
            <span className="font-medium underline underline-offset-2">
              Retry
            </span>
          </span>
        </span>
      </span>
    </GroupedRunLink>
  );
}

export const RunGroup = {
  Provider: RunGroupProvider,
  Frame: RunGroupFrame,
  Header: RunGroupHeader,
  Body: RunGroupBody,
  Runs: RunGroupRuns,
  ShowMore: RunGroupShowMore,
};

"use client";

import {
  type KeyboardEvent,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { isGridKey, nextGridCell } from "@/lib/grid-keyboard";
import { cn } from "@/lib/utils";
import { BLOCKS_PER_DAY } from "@/lib/watchers/block-edges";
import {
  blockSentence,
  blockWhen,
  describeBlock,
} from "@/lib/watchers/block-text";
import type { BlockState, HealthDay } from "@/lib/watchers/health";
import { longDayLabel, shortDayLabel } from "@/lib/watchers/range";

const BLOCK_CLASSNAMES: Record<BlockState, string> = {
  checked_in: "bg-green-500",
  restarted: "bg-neutral-400 dark:bg-neutral-500",
  missed: "bg-amber-500",
  unresponsive: "bg-red-500",
  no_data: "bg-neutral-200/70 dark:bg-neutral-800",
};

const LEGEND: { label: string; state: BlockState }[] = [
  { state: "checked_in", label: "Checked in" },
  { state: "restarted", label: "Restarted for an update" },
  { state: "missed", label: "Missed a heartbeat" },
  { state: "unresponsive", label: "Unresponsive" },
  { state: "no_data", label: "No data" },
];

const AXIS_HOURS = ["12 AM", "6 AM", "12 PM", "6 PM", "12 AM"];

interface Cell {
  col: number;
  row: number;
}

interface Anchor {
  height: number;
  left: number;
  top: number;
  width: number;
}

/** "Pacific Time": the viewer's zone, named the way a person says it. */
function zoneName(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longGeneric",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** The newest block that has started: where the keyboard enters the grid. */
function initialCell(days: HealthDay[]): Cell {
  for (let row = days.length - 1; row >= 0; row--) {
    for (let col = BLOCKS_PER_DAY - 1; col >= 0; col--) {
      if (days[row].blocks[col].noData !== "future") {
        return { row, col };
      }
    }
  }
  return { row: Math.max(days.length - 1, 0), col: 0 };
}

/**
 * The rows of blocks. A component of its own, so that moving the pointer or the
 * focus, which changes only the tooltip, doesn't draw a month of blocks again.
 */
const GridRows = memo(function GridRows({
  days,
  stop,
  timeZone,
}: {
  days: HealthDay[];
  /** The block that is the grid's tab stop. */
  stop: Cell;
  timeZone: string;
}) {
  return days.map((day, row) => {
    const dayText = longDayLabel(day.date);
    return (
      <div
        className="flex items-center gap-3"
        key={day.date}
        role="row"
        tabIndex={-1}
      >
        {/* Stays at the left edge when a narrow screen scrolls the blocks. The
            shadow covers the gap, so a block never shows between the label and
            the edge. */}
        <span
          className="sticky left-0 z-10 flex w-16 shrink-0 items-center self-stretch whitespace-nowrap bg-card text-muted-foreground text-xs shadow-[12px_0_0_0_var(--card)]"
          role="rowheader"
          tabIndex={-1}
        >
          {shortDayLabel(day.date)}
        </span>
        <div className="flex min-w-0 flex-1 gap-[3px]">
          {day.blocks.map((block, col) => {
            const text = describeBlock(
              block,
              blockWhen(dayText, col),
              timeZone
            );
            const isStop = row === stop.row && col === stop.col;
            return (
              <span
                aria-label={blockSentence(text)}
                className={cn(
                  "h-4 flex-1 rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  BLOCK_CLASSNAMES[block.state]
                )}
                data-cell={`${row}-${col}`}
                key={`${day.date}-${col}`}
                role="gridcell"
                tabIndex={isStop ? 0 : -1}
              />
            );
          })}
        </div>
      </div>
    );
  });
});

/**
 * Connectivity: a row per day and a block per 30 minutes, coloured by whether
 * the watcher checked in. The grid is one tab stop with a roving focus: the
 * arrow keys move between blocks, Home and End to the ends of a row. A single
 * tooltip follows the hovered or focused block, instead of one per block, so
 * a month of days stays light. The grid scrolls inside its box on a narrow
 * screen.
 */
export function ConnectivityGrid({ days }: { days: HealthDay[] }) {
  const timeZone = useViewerTimeZone();
  const gridRef = useRef<HTMLDivElement>(null);
  const [tabStop, setTabStop] = useState<Cell | null>(null);
  const [hovered, setHovered] = useState<Cell | null>(null);
  const [focused, setFocused] = useState<Cell | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const initial = useMemo(() => initialCell(days), [days]);
  const stop = tabStop ?? initial;
  const zone = useMemo(() => zoneName(timeZone), [timeZone]);
  const active = hovered ?? focused;

  const cellElement = useCallback(
    (cell: Cell) =>
      gridRef.current?.querySelector<HTMLElement>(
        `[data-cell="${cell.row}-${cell.col}"]`
      ) ?? null,
    []
  );

  // Put the tooltip's anchor over the active block. The anchor sits inside the
  // scrolling content, so it moves with the block.
  const activeRow = active?.row;
  const activeCol = active?.col;
  useLayoutEffect(() => {
    if (activeRow === undefined || activeCol === undefined) {
      setAnchor(null);
      return;
    }
    const element = cellElement({ row: activeRow, col: activeCol });
    const frame = gridRef.current;
    if (!(element && frame)) {
      setAnchor(null);
      return;
    }
    const cell = element.getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    setAnchor({
      left: cell.left - box.left,
      top: cell.top - box.top,
      width: cell.width,
      height: cell.height,
    });
  }, [activeRow, activeCol, cellElement]);

  function cellFromEvent(target: EventTarget | null): Cell | null {
    const element = (target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-cell]"
    );
    const [row, col] = element?.dataset.cell?.split("-").map(Number) ?? [];
    return row === undefined || col === undefined ? null : { row, col };
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!isGridKey(event)) {
      return;
    }
    const from = cellFromEvent(event.target);
    if (!from) {
      return;
    }
    // Always handled, so an arrow key at an edge never scrolls the page.
    event.preventDefault();
    const next = nextGridCell(
      { rows: days.length, cols: BLOCKS_PER_DAY, has: () => true },
      from,
      event.key,
      event.ctrlKey
    );
    if (next) {
      setTabStop(next);
      cellElement(next)?.focus();
    }
  }

  const activeText = (() => {
    if (!active) {
      return null;
    }
    const block = days[active.row]?.blocks[active.col];
    return block
      ? describeBlock(
          block,
          blockWhen(longDayLabel(days[active.row].date), active.col),
          timeZone
        )
      : null;
  })();

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-2">
        <div>
          <h3 className="font-semibold">Connectivity</h3>
          <p className="text-muted-foreground text-sm" suppressHydrationWarning>
            Each block is 30 minutes. {zone}.
          </p>
        </div>
        <ul className="flex flex-wrap gap-x-3.5 gap-y-1">
          {LEGEND.map((item) => (
            <li
              className="inline-flex items-center gap-1.5 text-muted-foreground text-xs"
              key={item.state}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 rounded-[3px] ring-1 ring-border/60 ring-inset",
                  BLOCK_CLASSNAMES[item.state]
                )}
              />
              {item.label}
            </li>
          ))}
        </ul>
      </div>

      {/* The grid scrolls inside its box when the screen is too narrow for 48
          blocks a row. */}
      <div className="overflow-x-auto pb-1">
        <Tooltip open={active !== null && activeText !== null}>
          <div
            aria-label="Connectivity by day and 30-minute block. Use the arrow keys to move between blocks."
            aria-rowcount={days.length}
            className="relative flex min-w-[560px] flex-col gap-1.5"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setFocused(null);
              }
            }}
            onFocus={(event) => setFocused(cellFromEvent(event.target))}
            onKeyDown={onKeyDown}
            onPointerLeave={() => setHovered(null)}
            onPointerOver={(event) => setHovered(cellFromEvent(event.target))}
            ref={gridRef}
            role="grid"
          >
            <GridRows days={days} stop={stop} timeZone={timeZone} />
            <div aria-hidden="true" className="flex gap-3">
              {/* Sticky like the day labels above, so the hours scroll under
                  the same strip and never show in the label column. */}
              <span className="sticky left-0 z-10 w-16 shrink-0 bg-card shadow-[12px_0_0_0_var(--card)]" />
              <div className="flex flex-1 justify-between text-muted-foreground text-xs">
                {AXIS_HOURS.map((hour, index) => (
                  // The labels are fixed and in order, and "12 AM" appears twice.
                  <span key={index}>{hour}</span>
                ))}
              </div>
            </div>
            <TooltipTrigger asChild>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute"
                style={
                  anchor
                    ? {
                        left: anchor.left,
                        top: anchor.top,
                        width: anchor.width,
                        height: anchor.height,
                      }
                    : { display: "none" }
                }
              />
            </TooltipTrigger>
          </div>
          <TooltipContent className="flex-col items-start gap-0.5" side="top">
            {activeText && (
              <>
                <p className="font-medium">{activeText.title}</p>
                <p className="opacity-80">{activeText.when}</p>
                {activeText.detail && <p>{activeText.detail}</p>}
              </>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

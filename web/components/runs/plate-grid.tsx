"use client";

import {
  Fragment,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildPlateLayout,
  nextPlateCell,
  plateCellKey,
} from "@/lib/runs/plate-wells";
import { cn } from "@/lib/utils";

const COMPACT_PLATE_MAX_COLS = 12;

const TILE_CLASS =
  "flex aspect-square flex-col overflow-hidden rounded-md border bg-background text-left outline-none ring-offset-background transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring";

// Memoized so opening or closing the well dialog does not re-render up to 384
// tiles behind it. Only the two tiles that gain or lose the tab stop update.
const WellTile = memo(function WellTile<W extends { well: string }>({
  className,
  isTabStop,
  onSelect,
  renderTile,
  well,
  style,
}: {
  className?: string;
  isTabStop: boolean;
  onSelect: (well: string) => void;
  renderTile: (well: W) => ReactNode;
  style?: React.CSSProperties;
  well: W;
}) {
  return (
    <button
      aria-label={`Open well ${well.well}`}
      className={cn(TILE_CLASS, className)}
      data-well={well.well}
      onClick={() => onSelect(well.well)}
      style={style}
      tabIndex={isTabStop ? 0 : -1}
      type="button"
    >
      {renderTile(well)}
    </button>
  );
}) as <W extends { well: string }>(props: {
  className?: string;
  isTabStop: boolean;
  onSelect: (well: string) => void;
  renderTile: (well: W) => ReactNode;
  style?: React.CSSProperties;
  well: W;
}) => ReactNode;

/**
 * A plate of wells as a grid of buttons, shared by the Aunty and qPCR viewers.
 * The whole plate is one tab stop: arrow keys move between wells, Home and End
 * jump along a row, and Enter or Space opens the well. A 384-well plate would
 * otherwise cost a keyboard user 384 Tab presses to get past it.
 *
 * `renderTile` draws what is inside a tile. Keep its identity stable (wrap it
 * in `useCallback`), or every tile re-renders on each change.
 */
export function PlateGrid<W extends { well: string }>({
  ariaLabel,
  onSelectWell,
  renderTile,
  wells,
}: {
  ariaLabel: string;
  onSelectWell: (well: string) => void;
  renderTile: (well: W) => ReactNode;
  wells: readonly W[];
}) {
  const layout = useMemo(() => buildPlateLayout(wells), [wells]);
  const containerRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  const firstPlaced = useMemo(() => {
    for (let row = 0; row < layout.rows; row++) {
      for (let col = 0; col < layout.cols; col++) {
        const well = layout.byPos.get(plateCellKey(row, col));
        if (well) {
          return well.well;
        }
      }
    }
    return null;
  }, [layout]);

  // The well that Tab lands on. It follows focus, so leaving the plate and
  // coming back returns to the last well used.
  const [activeWell, setActiveWell] = useState<string | null>(null);
  const placedLabels = useMemo(
    () => new Set([...layout.byPos.values()].map((w) => w.well)),
    [layout]
  );
  const tabStop =
    activeWell !== null && placedLabels.has(activeWell)
      ? activeWell
      : firstPlaced;

  const positions = useMemo(() => {
    const map = new Map<string, { row: number; col: number }>();
    for (const [key, well] of layout.byPos) {
      const [row, col] = key.split("-").map(Number);
      map.set(well.well, { row, col });
    }
    return map;
  }, [layout]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const current = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-well]"
      )?.dataset.well;
      const from = current ? positions.get(current) : undefined;
      if (!from) {
        return;
      }
      const next = nextPlateCell(
        {
          rows: layout.rows,
          cols: layout.cols,
          has: (row, col) => layout.byPos.has(plateCellKey(row, col)),
        },
        from,
        event.key,
        event.ctrlKey
      );
      const label = next
        ? layout.byPos.get(plateCellKey(next.row, next.col))?.well
        : null;
      if (!label) {
        return;
      }
      event.preventDefault();
      setActiveWell(label);
      containerRef.current
        ?.querySelector<HTMLElement>(`[data-well="${CSS.escape(label)}"]`)
        ?.focus();
    },
    [layout, positions]
  );

  const onFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const label = (event.target as HTMLElement).dataset.well;
    if (label) {
      setActiveWell(label);
    }
  }, []);

  if (layout.byPos.size === 0 && layout.unplaced.length === 0) {
    return null;
  }

  const rowLabels = Array.from({ length: layout.rows }, (_, i) =>
    String.fromCharCode(65 + i)
  );
  const colLabels = Array.from({ length: layout.cols }, (_, i) =>
    String(i + 1)
  );
  // Dense plates keep readable tiles and scroll sideways instead of shrinking.
  const wide = layout.cols > COMPACT_PLATE_MAX_COLS;
  const wellTrack = wide ? "4rem" : "minmax(0, 1fr)";

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <p className="sr-only" id={hintId}>
        Use the arrow keys to move between wells and Enter to open one.
      </p>
      {layout.byPos.size > 0 && (
        <div
          aria-describedby={hintId}
          aria-label={ariaLabel}
          className="w-full min-w-0 overflow-x-auto overscroll-x-contain"
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          ref={containerRef}
          role="group"
        >
          <div
            className={cn("grid gap-1.5", wide ? "w-max min-w-full" : "w-full")}
            style={{
              gridTemplateColumns: `1.5rem repeat(${layout.cols}, ${wellTrack})`,
            }}
          >
            {colLabels.map((c, ci) => (
              <div
                aria-hidden="true"
                className="py-0.5 text-center font-medium text-muted-foreground text-xs"
                key={c}
                style={{ gridRow: 1, gridColumn: ci + 2 }}
              >
                {c}
              </div>
            ))}
            {rowLabels.map((rowLabel, ri) => (
              <Fragment key={rowLabel}>
                <div
                  aria-hidden="true"
                  className="flex items-center justify-center font-medium text-muted-foreground text-xs"
                  style={{ gridRow: ri + 2, gridColumn: 1 }}
                >
                  {rowLabel}
                </div>
                {colLabels.map((_, ci) => {
                  const well = layout.byPos.get(plateCellKey(ri, ci));
                  const label = `${rowLabel}${ci + 1}`;
                  const style = { gridRow: ri + 2, gridColumn: ci + 2 };
                  if (!well) {
                    return (
                      <div
                        className="aspect-square rounded-md border border-transparent"
                        key={label}
                        style={style}
                      />
                    );
                  }
                  return (
                    <WellTile
                      isTabStop={well.well === tabStop}
                      key={label}
                      onSelect={onSelectWell}
                      renderTile={renderTile}
                      style={style}
                      well={well}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {layout.unplaced.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">
            Wells with labels outside the plate layout
          </span>
          <div className="flex flex-wrap gap-1.5">
            {layout.unplaced.map((well) => (
              <WellTile
                className="w-16"
                isTabStop
                key={well.well}
                onSelect={onSelectWell}
                renderTile={renderTile}
                well={well}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

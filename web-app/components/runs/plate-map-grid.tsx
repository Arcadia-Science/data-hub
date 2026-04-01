import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type WellData = { well: string; value: unknown };

// Parses standard microplate well notation (e.g. "A1", "H12", "P24").
// Rows A-P and columns 1-24 cover up to 384-well plates.
function parseWell(well: string): { row: number; col: number } | null {
  const match = well.match(/^([A-P])(\d{1,2})$/i);
  if (!match) return null;
  return {
    row: match[1].toUpperCase().charCodeAt(0) - 65,
    col: parseInt(match[2], 10) - 1,
  };
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? String(value)
      : value.toPrecision(4).replace(/\.?0+$/, "");
  }
  return String(value);
}

export function PlateMapGrid({ data }: { data: unknown }) {
  if (!Array.isArray(data)) return null;

  const wells = data as WellData[];
  if (wells.length === 0) return null;

  // Grid dimensions are inferred from the data so plates of any size (96, 384,
  // or custom layouts) render correctly without hard-coding dimensions.
  let maxRow = 0;
  let maxCol = 0;
  const cellMap = new Map<string, unknown>();

  for (const w of wells) {
    const pos = parseWell(w.well);
    if (!pos) continue;
    if (pos.row > maxRow) maxRow = pos.row;
    if (pos.col > maxCol) maxCol = pos.col;
    cellMap.set(`${pos.row}-${pos.col}`, w.value);
  }

  const rows = maxRow + 1;
  const cols = maxCol + 1;

  const rowLabels = Array.from({ length: rows }, (_, i) =>
    String.fromCharCode(65 + i)
  );
  const colLabels = Array.from({ length: cols }, (_, i) => String(i + 1));

  return (
    <div className="overflow-x-auto">
      <div
        className="inline-grid gap-px text-center"
        style={{
          gridTemplateColumns: `2rem repeat(${cols}, minmax(3rem, 1fr))`,
        }}
      >
        {/* Corner */}
        <div />
        {/* Column headers */}
        {colLabels.map((c) => (
          <div
            key={c}
            className="py-1 text-xs font-medium text-muted-foreground"
          >
            {c}
          </div>
        ))}

        {/* Data rows */}
        {rowLabels.map((rowLabel, ri) => (
          <>
            <div
              key={`row-${rowLabel}`}
              className="flex items-center justify-center py-1 text-xs font-medium text-muted-foreground"
            >
              {rowLabel}
            </div>
            {colLabels.map((_, ci) => {
              const value = cellMap.get(`${ri}-${ci}`);
              const display = formatCellValue(value);
              const full =
                value !== null && value !== undefined ? String(value) : "";
              const hasValue = display !== "";

              return (
                <Tooltip key={`${ri}-${ci}`}>
                  <TooltipTrigger asChild>
                    <div
                      className={`flex items-center justify-center rounded border px-1 py-1.5 font-mono text-[10px] ${
                        hasValue
                          ? "border-border bg-muted/50"
                          : "border-transparent"
                      }`}
                    >
                      {display || "·"}
                    </div>
                  </TooltipTrigger>
                  {hasValue && (
                    <TooltipContent>
                      <span className="font-mono">
                        {rowLabel}
                        {ci + 1}: {full}
                      </span>
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })}
          </>
        ))}
      </div>
    </div>
  );
}

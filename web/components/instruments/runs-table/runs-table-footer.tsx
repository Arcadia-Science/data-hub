export function RunsTableFooter({
  shownCount,
  totalCount,
}: {
  shownCount: number;
  totalCount: number;
}) {
  return (
    <div className="flex items-center border-t px-4 py-2.5 text-muted-foreground text-xs">
      <p>
        Showing <span className="tabular-nums">{shownCount}</span> of{" "}
        <span className="tabular-nums">{totalCount}</span>
      </p>
    </div>
  );
}

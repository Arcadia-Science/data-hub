export function RunsTableFooter({
  shownCount,
  totalCount,
  pendingUploadCount,
  unattributedCount,
  ranByYouCount,
}: {
  shownCount: number;
  totalCount: number;
  pendingUploadCount: number;
  unattributedCount: number;
  ranByYouCount: number;
}) {
  return (
    <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
      <p>
        Showing <span className="tabular-nums">{shownCount}</span> of{" "}
        <span className="tabular-nums">{totalCount}</span>
      </p>
      <p>
        <span className="tabular-nums">{pendingUploadCount}</span> pending
        upload · <span className="tabular-nums">{unattributedCount}</span>{" "}
        unattributed · <span className="tabular-nums">{ranByYouCount}</span> ran
        by you
      </p>
    </div>
  );
}

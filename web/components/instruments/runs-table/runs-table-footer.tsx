export function RunsTableFooter({
  shownCount,
  totalCount,
  pendingUploadCount,
  unattributedCount,
  ranByYouCount,
  // Trails the ran-by count. Third-person ("ran by Nadia") on another member's
  // runs page, where "ran by you" would misattribute the viewer.
  ranByLabel = "ran by you",
}: {
  shownCount: number;
  totalCount: number;
  pendingUploadCount: number;
  unattributedCount: number;
  ranByYouCount: number;
  ranByLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between border-t px-4 py-2.5 text-muted-foreground text-xs">
      <p>
        Showing <span className="tabular-nums">{shownCount}</span> of{" "}
        <span className="tabular-nums">{totalCount}</span>
      </p>
      <p>
        <span className="tabular-nums">{pendingUploadCount}</span> pending
        upload · <span className="tabular-nums">{unattributedCount}</span>{" "}
        unattributed · <span className="tabular-nums">{ranByYouCount}</span>{" "}
        {ranByLabel}
      </p>
    </div>
  );
}

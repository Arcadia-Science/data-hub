import { ExternalLink, Trash2 } from "lucide-react";
import Link from "next/link";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { NotebookActions } from "@/components/notebooks/notebook-actions";
import { RecordNotebookVisit } from "@/components/notebooks/record-notebook-visit";
import { RestoreNotebookButton } from "@/components/notebooks/restore-notebook-button";
import { ActorLabel } from "@/components/token-actor";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { UserAvatarLink } from "@/components/user-avatar";
import { notebookToWire } from "@/lib/api/notebook-wire";
import type { NotebookDto } from "@/lib/api/notebooks";
import { formatDateTime } from "@/lib/date";
import { countLabel } from "@/lib/notebooks/details";

function Dot() {
  return <span aria-hidden="true">·</span>;
}

/**
 * The top of a notebook's page: the breadcrumb, a banner when the notebook is
 * deleted, its name with the Open notebook button and the ⋯ menu, its
 * description, and a line with its owner, runs, instruments, and last run.
 */
export function NotebookHeader({
  notebook,
  timeZone,
  viewerId,
}: {
  notebook: NotebookDto;
  timeZone: string;
  viewerId: string;
}) {
  const deleted = notebook.deletedAt !== null;

  return (
    <div className="flex flex-col gap-4">
      <RecordNotebookVisit
        deleted={deleted}
        name={notebook.name}
        notebookId={notebook.id}
      />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/notebooks">Notebooks</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate">
              {notebook.name}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {notebook.deletedAt ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive text-sm">
          <div className="flex items-start gap-2">
            <Trash2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span>
                  Deleted {formatDateTime(notebook.deletedAt, timeZone)}
                </span>
                {notebook.deletedBy ? (
                  <span className="flex items-center gap-1.5">
                    <span>by</span>
                    <ActorLabel actor={notebook.deletedBy} />
                  </span>
                ) : null}
              </span>
              <span className="text-muted-foreground">
                Runs don&rsquo;t list this notebook until it&rsquo;s restored.
              </span>
            </div>
          </div>
          <RestoreNotebookButton notebookId={notebook.id} />
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <h1 className="min-w-0 break-words font-semibold text-2xl tracking-tight">
          {notebook.name}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={notebook.url} rel="noopener noreferrer" target="_blank">
              <ExternalLink aria-hidden="true" className="size-4" />
              Open notebook
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Button>
          <NotebookActions
            notebook={notebookToWire(notebook)}
            viewerId={viewerId}
          />
        </div>
      </div>

      {notebook.description ? (
        <p className="max-w-3xl whitespace-pre-line text-pretty text-muted-foreground text-sm">
          {notebook.description}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
        {notebook.owner ? (
          <span className="inline-flex items-center gap-1.5">
            Owner
            <UserAvatarLink user={notebook.owner}>
              <span className="font-medium text-foreground">
                {notebook.owner.displayName}
              </span>
            </UserAvatarLink>
          </span>
        ) : (
          <span>No owner</span>
        )}
        <Dot />
        {notebook.runCount === 0 ? (
          <span>No runs yet</span>
        ) : (
          <>
            <span className="tabular-nums">
              {countLabel(notebook.runCount, "run")}
            </span>
            <Dot />
            <span className="tabular-nums">
              {countLabel(notebook.instrumentCount, "instrument")}
            </span>
            {notebook.lastRunAt ? (
              <>
                <Dot />
                <span>
                  Last run{" "}
                  <RelativeTime date={notebook.lastRunAt.toISOString()} />
                </span>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

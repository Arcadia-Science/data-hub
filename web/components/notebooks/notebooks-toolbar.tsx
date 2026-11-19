"use client";

import { Search } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useId } from "react";
import { useTablePending } from "@/components/table-pending";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { notebooksIndexSearchParams } from "@/lib/search-params";

const toolbarParams = {
  q: notebooksIndexSearchParams.q,
  include_deleted: notebooksIndexSearchParams.include_deleted,
  page: notebooksIndexSearchParams.page,
};

/**
 * The search box and the deleted-notebooks switch above the `/notebooks`
 * table. Both live in the URL, and a change goes back to page 1.
 */
export function NotebooksToolbar() {
  const { startTransition } = useTablePending();
  const [params, setParams] = useQueryStates(toolbarParams, {
    shallow: false,
    throttleMs: 300,
    startTransition,
  });
  const switchId = useId();

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative w-full sm:w-80">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search notebooks"
          className="pl-9"
          onChange={(event) => setParams({ q: event.target.value, page: null })}
          placeholder="Search by name or paste a link…"
          value={params.q}
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={params.include_deleted}
          id={switchId}
          onCheckedChange={(checked) =>
            setParams({ include_deleted: checked, page: null })
          }
        />
        <Label className="font-normal" htmlFor={switchId}>
          Show deleted notebooks
        </Label>
      </div>
    </div>
  );
}

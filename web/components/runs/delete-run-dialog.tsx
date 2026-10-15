"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import {
  DeleteRunsDialog,
  type DeleteRunTarget,
} from "@/components/runs/delete-runs-dialog";
import { Button } from "@/components/ui/button";

// The run page's Delete button. The confirmation window, the type-the-run-ID
// check, and the request all live in `DeleteRunsDialog`, which the list's row
// menu and bulk action bar share, so the rules cannot drift apart.
export function DeleteRunDialog(run: DeleteRunTarget) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        className="gap-1.5 border-destructive/30 bg-background text-destructive text-sm hover:bg-destructive/5 hover:text-destructive"
        onClick={() => setOpen(true)}
        size="sm"
        variant="outline"
      >
        <Trash2 className="size-4" />
        Delete
      </Button>
      <DeleteRunsDialog onOpenChange={setOpen} open={open} runs={[run]} />
    </>
  );
}

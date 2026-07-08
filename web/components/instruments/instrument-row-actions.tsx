"use client";

import {
  Archive,
  EllipsisVertical,
  Eye,
  Pencil,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EditInstrumentDialog } from "@/components/instruments/edit-instrument-dialog";
import { ReactivateInstrumentDialog } from "@/components/instruments/reactivate-instrument-dialog";
import { RetireInstrumentDialog } from "@/components/instruments/retire-instrument-dialog";
import { StatusActions } from "@/components/instruments/status-actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InstrumentListItem } from "@/lib/api/instruments";

// Admin row actions for the instruments table: an inline Confirm button for
// pending instruments, plus a three-dot menu whose items open trigger-less,
// controlled dialogs (same pattern as the runs table's `RunRowActions`). The
// destructive item swaps between Retire (active/pending) and Reactivate
// (retired) based on the row's lifecycle status.
export function InstrumentRowActions({ row }: { row: InstrumentListItem }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);

  const isRetired = row.status === "inactive";

  return (
    <div className="flex items-center justify-end gap-1">
      {row.status === "pending" ? (
        <StatusActions instrumentId={row.id} />
      ) : null}

      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More actions"
            className="size-7"
            size="icon"
            type="button"
            variant="ghost"
          >
            <EllipsisVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem asChild>
            <Link href={`/instruments/${row.id}`}>
              <Eye className="size-3.5" />
              View details
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              setEditOpen(true);
            }}
          >
            <Pencil className="size-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {isRetired ? (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                setReactivateOpen(true);
              }}
            >
              <RotateCcw className="size-3.5" />
              Reactivate instrument
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                setRetireOpen(true);
              }}
              variant="destructive"
            >
              <Archive className="size-3.5" />
              Retire instrument
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <EditInstrumentDialog
        displayName={row.displayName}
        instrumentId={row.id}
        instrumentType={row.instrumentType}
        onOpenChange={setEditOpen}
        open={editOpen}
      />
      <RetireInstrumentDialog
        displayName={row.displayName}
        instrumentId={row.id}
        onOpenChange={setRetireOpen}
        open={retireOpen}
        runCount={row.runCount}
        watcherCount={row.watcherCount}
      />
      <ReactivateInstrumentDialog
        displayName={row.displayName}
        instrumentId={row.id}
        onOpenChange={setReactivateOpen}
        open={reactivateOpen}
      />
    </div>
  );
}

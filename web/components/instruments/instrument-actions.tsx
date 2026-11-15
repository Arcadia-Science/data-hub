"use client";

import { EllipsisVertical } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ConfirmInstrumentDialog } from "@/components/instruments/confirm-instrument-dialog";
import { EditInstrumentDialog } from "@/components/instruments/edit-instrument-dialog";
import { ReactivateInstrumentDialog } from "@/components/instruments/reactivate-instrument-dialog";
import { RetireInstrumentDialog } from "@/components/instruments/retire-instrument-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InstrumentListItem } from "@/lib/api/instruments";
import { watcherPageHref } from "@/lib/watchers/routes";

// Both `InstrumentListItem` (table) and `InstrumentDetail` (header) satisfy
// this, so one component drives both surfaces.
export type InstrumentActionTarget = Pick<
  InstrumentListItem,
  "displayName" | "id" | "instrumentType" | "runCount" | "status" | "watcher"
>;

// `variant` only changes the trigger: `expanded` is the outline icon used
// in the header; `menu` is the denser ghost icon used in the table.
export function InstrumentActions({
  instrument,
  variant = "menu",
}: {
  instrument: InstrumentActionTarget;
  variant?: "menu" | "expanded";
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);

  const isRetired = instrument.status === "inactive";
  const expanded = variant === "expanded";

  return (
    <div
      className={
        expanded
          ? "flex items-center justify-end gap-2"
          : "flex items-center justify-end gap-1"
      }
    >
      {/* The instrument page confirms from its pending card, so the header leaves
          the button out. */}
      {instrument.status === "pending" && !expanded ? (
        <ConfirmInstrumentDialog
          displayName={instrument.displayName}
          instrumentId={instrument.id}
        >
          <Button
            className="h-7 gap-1 text-xs"
            size="sm"
            type="button"
            variant="outline"
          >
            Confirm…
            <span className="sr-only"> {instrument.displayName}</span>
          </Button>
        </ConfirmInstrumentDialog>
      ) : null}

      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          {expanded ? (
            <Button
              aria-label="More actions"
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <EllipsisVertical className="size-4" />
            </Button>
          ) : (
            <Button
              aria-label="More actions"
              className="size-7"
              size="icon"
              type="button"
              variant="ghost"
            >
              <EllipsisVertical className="size-4" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              setEditOpen(true);
            }}
          >
            Edit details
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={watcherPageHref(instrument.id)}>Watcher</Link>
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
              Reactivate
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
              Retire
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <EditInstrumentDialog
        displayName={instrument.displayName}
        instrumentId={instrument.id}
        instrumentType={instrument.instrumentType}
        onOpenChange={setEditOpen}
        open={editOpen}
      />
      <RetireInstrumentDialog
        displayName={instrument.displayName}
        hasWatcher={instrument.watcher !== null}
        instrumentId={instrument.id}
        onOpenChange={setRetireOpen}
        open={retireOpen}
        runCount={instrument.runCount}
      />
      <ReactivateInstrumentDialog
        displayName={instrument.displayName}
        instrumentId={instrument.id}
        onOpenChange={setReactivateOpen}
        open={reactivateOpen}
      />
    </div>
  );
}

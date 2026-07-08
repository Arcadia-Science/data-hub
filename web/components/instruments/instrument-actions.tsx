"use client";

import { Archive, EllipsisVertical, Pencil, RotateCcw } from "lucide-react";
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

// Both `InstrumentListItem` (table) and `InstrumentDetail` (header) satisfy
// this, so one component drives both surfaces.
export type InstrumentActionTarget = Pick<
  InstrumentListItem,
  | "displayName"
  | "id"
  | "instrumentType"
  | "runCount"
  | "status"
  | "watcherCount"
>;

// `variant` picks the layout: `menu` folds Edit into the three-dot menu (dense
// table); `expanded` pulls Edit out as its own button beside the menu (header).
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
      {instrument.status === "pending" ? (
        <StatusActions instrumentId={instrument.id} />
      ) : null}

      {expanded ? (
        <Button
          onClick={() => setEditOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Pencil className="size-3.5" />
          Edit
        </Button>
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
          {expanded ? null : (
            <>
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
            </>
          )}
          {isRetired ? (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                setReactivateOpen(true);
              }}
            >
              <RotateCcw className="size-3.5" />
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
              <Archive className="size-3.5" />
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
        instrumentId={instrument.id}
        onOpenChange={setRetireOpen}
        open={retireOpen}
        runCount={instrument.runCount}
        watcherCount={instrument.watcherCount}
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

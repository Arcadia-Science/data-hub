"use client";

import {
  Archive,
  EllipsisVertical,
  Pencil,
  Radio,
  RotateCcw,
  SlidersHorizontal,
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
import { EditWatcherConfigDialog } from "@/components/watchers/edit-watcher-config-dialog";
import type { InstrumentListItem } from "@/lib/api/instruments";
import type { WatcherConfigState } from "@/lib/api/watcher-config/revisions";

// Loaded only on the instrument page, for admins, when a live watcher exists.
export interface InstrumentWatcherConfig {
  hostname: string | null;
  online: boolean;
  state: WatcherConfigState;
  watcherId: string;
}

// Both `InstrumentListItem` (table) and `InstrumentDetail` (header) satisfy
// this, so one component drives both surfaces.
export type InstrumentActionTarget = Pick<
  InstrumentListItem,
  | "activeWatcherId"
  | "displayName"
  | "id"
  | "instrumentType"
  | "runCount"
  | "status"
  | "watcherCount"
>;

// `variant` only changes the trigger: `expanded` is the outline icon used
// in the header; `menu` is the denser ghost icon used in the table.
export function InstrumentActions({
  instrument,
  variant = "menu",
  watcherConfig = null,
}: {
  instrument: InstrumentActionTarget;
  variant?: "menu" | "expanded";
  /** Adds "Edit watcher config" when set (instrument page only). */
  watcherConfig?: InstrumentWatcherConfig | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [watcherConfigOpen, setWatcherConfigOpen] = useState(false);
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
            <Pencil className="size-3.5" />
            Edit details
          </DropdownMenuItem>
          {watcherConfig ? (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                setWatcherConfigOpen(true);
              }}
            >
              <SlidersHorizontal className="size-3.5" />
              Edit watcher config
            </DropdownMenuItem>
          ) : null}
          {instrument.activeWatcherId ? (
            <DropdownMenuItem asChild>
              <Link href={`/watchers/${instrument.activeWatcherId}`}>
                <Radio className="size-3.5" />
                View watcher
              </Link>
            </DropdownMenuItem>
          ) : null}
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
      {watcherConfig ? (
        <EditWatcherConfigDialog
          hostname={watcherConfig.hostname}
          onOpenChange={setWatcherConfigOpen}
          open={watcherConfigOpen}
          state={watcherConfig.state}
          watcherId={watcherConfig.watcherId}
          watcherOnline={watcherConfig.online}
        />
      ) : null}
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

"use client";

import { EllipsisVertical } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeregisterDialog } from "@/components/watchers/deregister-dialog";
import type { ActiveWatcherRow } from "@/lib/watchers/roster";

export type WatcherActionTarget = Pick<
  ActiveWatcherRow,
  "hostname" | "id" | "instrumentDisplayName" | "instrumentId"
>;

export function WatcherActions({ watcher }: { watcher: WatcherActionTarget }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deregisterOpen, setDeregisterOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const instrumentName = watcher.instrumentDisplayName ?? watcher.instrumentId;

  return (
    <div className="flex items-center justify-end">
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for the ${instrumentName} watcher`}
            className="size-7"
            ref={triggerRef}
            size="icon"
            type="button"
            variant="ghost"
          >
            <EllipsisVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              setDeregisterOpen(true);
            }}
            variant="destructive"
          >
            Deregister
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeregisterDialog
        hostname={watcher.hostname}
        onOpenChange={setDeregisterOpen}
        open={deregisterOpen}
        returnFocusRef={triggerRef}
        watcherId={watcher.id}
      />
    </div>
  );
}

"use client";

import { EllipsisVertical, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeregisterDialog } from "@/components/watchers/deregister-dialog";
import type { WatcherListItem } from "@/lib/api/watchers";

export type WatcherActionTarget = Pick<
  WatcherListItem,
  "deletedAt" | "hostname" | "id"
>;

export function WatcherActions({ watcher }: { watcher: WatcherActionTarget }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deregisterOpen, setDeregisterOpen] = useState(false);

  if (watcher.deletedAt) {
    return null;
  }

  return (
    <div className="flex items-center justify-end">
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
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              setDeregisterOpen(true);
            }}
            variant="destructive"
          >
            <Trash2 className="size-3.5" />
            Deregister
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeregisterDialog
        hostname={watcher.hostname}
        onOpenChange={setDeregisterOpen}
        open={deregisterOpen}
        watcherId={watcher.id}
      />
    </div>
  );
}

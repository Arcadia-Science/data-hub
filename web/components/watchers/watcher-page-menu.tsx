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

/**
 * The admin-only ⋮ menu on the watcher page. Deregister is the only action,
 * and only for the instrument's current watcher: a past watcher is already
 * deregistered, so the page doesn't render this menu for it.
 */
export function WatcherPageMenu({
  watcherId,
  hostname,
}: {
  watcherId: string;
  hostname: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deregisterOpen, setDeregisterOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Watcher actions"
            ref={triggerRef}
            size="icon-sm"
            type="button"
            variant="outline"
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
        hostname={hostname}
        onOpenChange={setDeregisterOpen}
        open={deregisterOpen}
        returnFocusRef={triggerRef}
        watcherId={watcherId}
      />
    </>
  );
}

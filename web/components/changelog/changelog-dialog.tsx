"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChangelogFeed } from "@/components/changelog/changelog-feed";
import { ChangelogSeenProvider } from "@/components/changelog/changelog-seen";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { changelogIntro } from "@/lib/changelog/copy";
import type { ChangelogDaySection } from "@/lib/changelog/group";

export function ChangelogDialog({
  ids,
  onOpenChange,
  open,
  sections,
}: {
  ids: readonly string[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  sections: readonly ChangelogDaySection[];
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="data-open:fade-in-0 data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-[#171717]/22 backdrop-blur-[5px] duration-100 data-closed:animate-out data-open:animate-in" />
        <DialogPrimitive.Content className="data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-1/2 left-1/2 z-50 flex h-[min(788px,calc(100svh-2rem))] w-[min(680px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-[0_24px_64px_-16px_rgba(0,0,0,0.28)] outline-none duration-100 data-closed:animate-out data-open:animate-in md:h-[min(788px,calc(100svh-7rem))]">
          <div className="flex shrink-0 items-start justify-between gap-4 border-border border-b pt-7 pr-6 pb-5 pl-8">
            <div className="flex flex-col gap-1.5">
              <DialogTitle className="font-semibold text-xl leading-snug tracking-[-0.01em]">
                Changelog
              </DialogTitle>
              <DialogDescription className="text-[15px] text-muted-foreground leading-normal">
                {changelogIntro}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button
                aria-label="Close"
                className="-mt-1.5"
                size="icon-lg"
                type="button"
                variant="ghost"
              >
                <XIcon className="size-[18px]" />
              </Button>
            </DialogClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ChangelogSeenProvider ids={ids}>
              <ChangelogFeed sections={sections} />
            </ChangelogSeenProvider>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}

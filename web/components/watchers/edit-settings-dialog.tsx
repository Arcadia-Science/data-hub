"use client";

import { type ComponentProps, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { WatcherConfigForm } from "@/components/watchers/watcher-config-form";

/**
 * The Edit button on the Current settings card, and the form it opens in a
 * dialog. A link such as "Change folder" (`?focus=watch_directory`) opens the
 * dialog straight away, with the cursor in that field. A save closes it.
 */
export function EditSettingsDialog(
  props: Omit<ComponentProps<typeof WatcherConfigForm>, "onSaved">
) {
  const [open, setOpen] = useState(props.focusField !== undefined);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        {/* The name says what the button edits; it still starts with the
            visible label. */}
        <Button aria-label="Edit settings" size="sm" variant="outline">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        // The form puts the cursor in the field the link asked for, so the
        // dialog mustn't move it to the first field.
        onOpenAutoFocus={(event) => {
          if (props.focusField) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit settings</DialogTitle>
          <DialogDescription>
            Saved changes reach the watcher within about a minute. If it
            can&apos;t apply one, it keeps its current settings and the change
            shows as rejected.
          </DialogDescription>
        </DialogHeader>
        {/* A new revision starts the form again from that revision. */}
        <WatcherConfigForm
          key={props.baseRevision ?? "none"}
          {...props}
          onSaved={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

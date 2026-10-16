"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

// Stands in for the preview window while its code downloads, so the first click
// on a file name shows something right away. Closing it cancels the preview.
export function FilePreviewLoading({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle className="sr-only">Loading preview…</DialogTitle>
        <DialogDescription className="sr-only">
          The file preview is loading.
        </DialogDescription>
        <Skeleton aria-hidden className="h-64 w-full" />
      </DialogContent>
    </Dialog>
  );
}

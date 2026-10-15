"use client";

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import {
  usePlateWellsActions,
  usePlateWellsState,
} from "@/components/runs/plate-wells-provider";
import { SeekerToolbar } from "@/components/runs/report-item-seeker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

const WELL_SEEKER_LABELS = {
  empty: "No wells found.",
  next: "Next well",
  previous: "Previous well",
  search: "Search wells…",
  select: "Select a well…",
};

/**
 * The frame of a single-well dialog: title, the seeker that steps between
 * wells, any extra controls, and the body. The Aunty and qPCR dialogs differ
 * in what they plot, so each passes its own controls and body.
 */
export function WellDialogShell({
  children,
  controls,
  description,
  onOpenChange,
  open,
  title,
}: {
  children: ReactNode;
  controls: ReactNode;
  // Screen readers announce this as the dialog's description.
  description: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  const state = usePlateWellsState();
  const actions = usePlateWellsActions();

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-3xl" showCloseButton>
        <DialogHeader>
          <DialogTitle className="font-mono text-2xl">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <SeekerToolbar
            actions={actions}
            labels={WELL_SEEKER_LABELS}
            state={state}
          />
          {controls}
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Shown in place of a curve whose download failed. */
export function CurveLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 p-6 text-center"
      role="alert"
    >
      <AlertTriangle aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">{message}</p>
      <Button onClick={onRetry} size="sm" variant="outline">
        Retry
      </Button>
    </div>
  );
}

/** Placeholder while a curve downloads. */
export function CurveLoading() {
  return (
    <Skeleton
      aria-label="Loading curve"
      className="h-80 w-full"
      role="status"
    />
  );
}

"use client";

import { ExternalLink, Plus } from "lucide-react";
import { InstrumentStatusBadge } from "@/components/instruments/instrument-status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const STEPS = [
  {
    title: "Install the watcher on the instrument PC",
    description:
      "A lab operator runs the watcher and registers the instrument. You'll need a personal access token.",
  },
  {
    title: "Activate it here",
    description: (
      <>
        It appears with a <InstrumentStatusBadge status="pending" /> badge. An
        admin clicks Confirm.
      </>
    ),
  },
  {
    title: "Start watching",
    description: "Runs and files appear in the dashboard as they upload.",
  },
] as const;

export function AddInstrumentDialog({
  setupGuideUrl,
  getTokenUrl,
}: {
  setupGuideUrl: string;
  getTokenUrl: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus data-icon="inline-start" />
          Add instrument
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an instrument</DialogTitle>
          <DialogDescription>
            Instruments are registered from the instrument PC, then activated
            here.
          </DialogDescription>
        </DialogHeader>
        <ol className="grid gap-4">
          {STEPS.map((step, index) => (
            <li className="flex gap-3" key={step.title}>
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sky-100 font-medium text-sky-700 text-xs dark:bg-sky-950 dark:text-sky-300"
              >
                {index + 1}
              </span>
              <div className="grid gap-1 pt-0.5">
                <p className="font-medium leading-none">{step.title}</p>
                <p className="text-muted-foreground text-sm leading-snug">
                  {step.description}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <DialogFooter className="sm:justify-between">
          <Button asChild size="sm">
            <a href={setupGuideUrl} rel="noopener noreferrer" target="_blank">
              Open setup guide
              <ExternalLink className="size-3" />
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={getTokenUrl} rel="noopener noreferrer" target="_blank">
              Get a token
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

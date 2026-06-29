"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface AdjacentRun {
  href: string;
  runId: string;
}

// Previous/next navigation between an instrument's runs, ordered newest-first
// to match the runs table. `previous` is the newer run, `next` the older one;
// a null neighbor means we're at that end of the list, so the button renders
// disabled rather than as a link.
export function RunNav({
  previous,
  next,
}: {
  next: AdjacentRun | null;
  previous: AdjacentRun | null;
}) {
  return (
    <div className="flex items-center gap-1">
      <RunNavButton
        direction="Previous"
        icon={<ChevronLeft />}
        run={previous}
      />
      <RunNavButton direction="Next" icon={<ChevronRight />} run={next} />
    </div>
  );
}

function RunNavButton({
  direction,
  icon,
  run,
}: {
  direction: "Previous" | "Next";
  icon: React.ReactNode;
  run: AdjacentRun | null;
}) {
  if (!run) {
    return (
      <Button
        aria-label={`${direction} run`}
        disabled
        size="icon-sm"
        variant="outline"
      >
        {icon}
      </Button>
    );
  }

  const label = `${direction} run: ${run.runId}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} asChild size="icon-sm" variant="outline">
          <Link href={run.href}>{icon}</Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

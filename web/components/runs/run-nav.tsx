"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Previous/next navigation between an instrument's runs, ordered newest-first
// to match the runs table. `previousHref` is the newer run, `nextHref` the
// older one; a null href means we're at that end of the list, so the button
// renders disabled rather than as a link.
export function RunNav({
  previousHref,
  nextHref,
}: {
  nextHref: string | null;
  previousHref: string | null;
}) {
  return (
    <div className="flex items-center gap-1">
      <RunNavButton
        href={previousHref}
        icon={<ChevronLeft />}
        label="Previous (newer) run"
      />
      <RunNavButton
        href={nextHref}
        icon={<ChevronRight />}
        label="Next (older) run"
      />
    </div>
  );
}

function RunNavButton({
  href,
  icon,
  label,
}: {
  href: string | null;
  icon: React.ReactNode;
  label: string;
}) {
  if (!href) {
    return (
      <Button aria-label={label} disabled size="icon-sm" variant="outline">
        {icon}
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} asChild size="icon-sm" variant="outline">
          <Link href={href}>{icon}</Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

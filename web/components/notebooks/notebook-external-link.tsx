"use client";

import { ExternalLink } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The small icon link beside a notebook's name that opens the notebook's own
 * page, such as its Notion page, in a new tab. The name itself opens the
 * notebook's page in Data Hub.
 */
export function NotebookExternalLink({
  className,
  name,
  url,
}: {
  className?: string;
  name: string;
  url: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          aria-label={`Open ${name} in a new tab`}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
          href={url}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      </TooltipTrigger>
      <TooltipContent side="top">Open in a new tab</TooltipContent>
    </Tooltip>
  );
}

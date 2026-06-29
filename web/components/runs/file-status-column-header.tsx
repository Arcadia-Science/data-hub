"use client";

import { CircleHelp, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  FILE_STATUS_CONFIG,
  FILE_STATUS_LEGEND_SECTIONS,
} from "./file-status-config";

function FileStatusLegendContent() {
  return (
    <div className="flex flex-col gap-4">
      {FILE_STATUS_LEGEND_SECTIONS.map((section) => (
        <section className="flex flex-col gap-2" key={section.key}>
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {section.title}
          </h3>
          <ul className="flex flex-col gap-2">
            {section.statuses.map((statusKey) => {
              const { label, description, Icon, className, spin } =
                FILE_STATUS_CONFIG[statusKey];

              return (
                <li className="flex items-start gap-2" key={statusKey}>
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      className,
                      spin && "animate-spin"
                    )}
                  />
                  <p className="text-sm leading-snug">
                    <span className={cn("font-medium", className)}>
                      {label}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      — {description}
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function FileStatusColumnHeader() {
  const [open, setOpen] = useState(false);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label="About file status"
        className="inline-flex h-8 cursor-help items-center gap-1.5 font-medium text-foreground"
        type="button"
      >
        Status
        <CircleHelp
          aria-hidden="true"
          className="size-3 text-muted-foreground"
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-4 p-4" side="bottom">
        <div className="flex items-start justify-between gap-4">
          <PopoverHeader>
            <PopoverTitle>File status</PopoverTitle>
            <PopoverDescription>
              Where a file is in its lifecycle.
            </PopoverDescription>
          </PopoverHeader>
          <Button
            aria-label="Close file status legend"
            className="size-7 shrink-0"
            onClick={() => setOpen(false)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
        <FileStatusLegendContent />
      </PopoverContent>
    </Popover>
  );
}

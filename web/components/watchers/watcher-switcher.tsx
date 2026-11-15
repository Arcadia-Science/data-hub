"use client";

import { Check, ChevronDown, History } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import {
  summarizeRegistration,
  type WatcherRegistration,
} from "@/lib/watchers/registrations";
import { type WatcherTab, watcherPageHref } from "@/lib/watchers/routes";

const UNNAMED_COMPUTER = "Unnamed computer";

/**
 * The button at the top of the summary strip that switches between an
 * instrument's watcher registrations. Each option is a link to the same
 * sub-tab of that registration, so the choice is in the URL. The instrument's
 * current registration links without `?watcher=`.
 */
export function WatcherSwitcher({
  instrumentId,
  registrations,
  selectedId,
  tab,
}: {
  instrumentId: string;
  /** Every registration, newest first. */
  registrations: readonly WatcherRegistration[];
  selectedId: string;
  tab: WatcherTab;
}) {
  const timeZone = useViewerTimeZone();
  const selected = registrations.find((r) => r.id === selectedId);
  const isPast = selected ? selected.deletedAt !== null : false;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="max-w-full"
          size="sm"
          type="button"
          variant="outline"
        >
          <History
            aria-hidden="true"
            className="text-muted-foreground"
            data-icon="inline-start"
          />
          <span className="min-w-0 truncate">
            Viewing{" "}
            <span className="font-mono text-[13px]">
              {selected?.hostname ?? UNNAMED_COMPUTER}
            </span>
          </span>
          {isPast ? (
            <span className="shrink-0 font-normal text-muted-foreground">
              · past watcher
            </span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className="text-muted-foreground"
            data-icon="inline-end"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuLabel className="sr-only">
          Watchers for this instrument
        </DropdownMenuLabel>
        {registrations.map((registration) => {
          const summary = summarizeRegistration(registration, timeZone);
          const isSelected = registration.id === selectedId;
          return (
            <DropdownMenuItem asChild key={registration.id}>
              <Link
                aria-current={isSelected ? "true" : undefined}
                className="items-start gap-2.5"
                href={watcherPageHref(instrumentId, {
                  tab,
                  watcherId: registration.deletedAt ? registration.id : null,
                })}
              >
                <span className="mt-0.5 size-4 shrink-0">
                  {isSelected ? (
                    <Check aria-hidden="true" className="size-4" />
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="break-all font-mono text-[13px]">
                      {registration.hostname ?? UNNAMED_COMPUTER}
                    </span>
                    {summary.tag ? (
                      <span className="font-medium text-green-700 text-xs dark:text-green-400">
                        {summary.tag}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {summary.detail}
                  </span>
                </span>
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

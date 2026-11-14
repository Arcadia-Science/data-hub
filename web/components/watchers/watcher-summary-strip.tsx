import { Layers } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { HeartbeatValue } from "@/components/watchers/heartbeat-value";
import { WatcherSwitcher } from "@/components/watchers/watcher-switcher";
import type { SharedComputerInstrument } from "@/lib/instruments/connection";
import { cn } from "@/lib/utils";
import type { WatcherRegistration } from "@/lib/watchers/registrations";
import { type WatcherTab, watcherPageHref } from "@/lib/watchers/routes";
import {
  sharedComputerLine,
  versionSuffix,
  versionSuffixText,
} from "@/lib/watchers/summary";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function VersionValue({
  version,
  latestVersion,
}: {
  version: string | null;
  latestVersion: string | null;
}) {
  if (!version) {
    return <span className="text-muted-foreground">&mdash;</span>;
  }
  const suffix = versionSuffix(version, latestVersion);
  return (
    <>
      {version}
      {suffix ? (
        <span
          className={cn(
            "text-xs",
            suffix.kind === "up_to_date"
              ? "text-green-700 dark:text-green-400"
              : "text-muted-foreground"
          )}
        >
          {" "}
          · {versionSuffixText(suffix)}
        </span>
      ) : null}
    </>
  );
}

function SharedComputerFooter({
  others,
}: {
  others: readonly SharedComputerInstrument[];
}) {
  return (
    <div className="flex items-center gap-2 border-t px-5 py-3">
      <Layers
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <p className="min-w-0">
        {sharedComputerLine(others).map((part) =>
          part.kind === "text" ? (
            <span key={part.key}>{part.text}</span>
          ) : (
            <Link
              className="font-medium underline underline-offset-4 hover:no-underline"
              href={watcherPageHref(part.instrument.instrumentId)}
              key={part.key}
            >
              {part.instrument.displayName}
            </Link>
          )
        )}
      </p>
    </div>
  );
}

/**
 * The card under the watcher page's heading: the watcher's computer, system,
 * version, last heartbeat and upload mode, the switcher between registrations
 * when there is more than one, and, in the footer, a note when other
 * instruments' watchers run on the same computer.
 */
export function WatcherSummaryStrip({
  instrumentId,
  tab,
  watcher,
  isPast,
  uploadMode,
  latestVersion,
  sharedComputerWith,
  registrations,
  showSwitcher,
}: {
  instrumentId: string;
  tab: WatcherTab;
  watcher: {
    id: string;
    hostname: string | null;
    osInfo: string | null;
    watcherVersion: string | null;
    lastHeartbeatAt: Date | null;
  };
  isPast: boolean;
  uploadMode: "auto" | "manual";
  latestVersion: string | null;
  sharedComputerWith: readonly SharedComputerInstrument[];
  registrations: readonly WatcherRegistration[];
  showSwitcher: boolean;
}) {
  return (
    <Card className="gap-0 py-0">
      {showSwitcher ? (
        <div className="px-5 pt-3">
          <WatcherSwitcher
            instrumentId={instrumentId}
            registrations={registrations}
            selectedId={watcher.id}
            tab={tab}
          />
        </div>
      ) : null}
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-4 px-5 py-4">
        <Fact label="Computer">
          {watcher.hostname ? (
            <span className="break-all font-mono text-[13px]">
              {watcher.hostname}
            </span>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </Fact>
        <Fact label="Operating system">
          {watcher.osInfo ?? (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </Fact>
        <Fact label="Version">
          {isPast ? (
            (watcher.watcherVersion ?? (
              <span className="text-muted-foreground">&mdash;</span>
            ))
          ) : (
            <VersionValue
              latestVersion={latestVersion}
              version={watcher.watcherVersion}
            />
          )}
        </Fact>
        <Fact label="Last heartbeat">
          <HeartbeatValue date={watcher.lastHeartbeatAt} relative={!isPast} />
        </Fact>
        <Fact label="Upload mode">
          {uploadMode === "manual" ? "Manual" : "Automatic"}
        </Fact>
      </dl>
      {sharedComputerWith.length > 0 ? (
        <SharedComputerFooter others={sharedComputerWith} />
      ) : null}
    </Card>
  );
}

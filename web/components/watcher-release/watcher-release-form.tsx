"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatRelativeTime } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

type WatcherReleaseFormValues = {
  latestVersion: string;
  minSupportedVersion: string;
  channel: string;
  mandatory: boolean;
};

type LastUpdated = {
  at: string;
  byName: string | null;
  byEmail: string | null;
};

type WatcherReleaseFormProps = {
  initial: WatcherReleaseFormValues;
  lastUpdated: LastUpdated | null;
};

export function WatcherReleaseForm({
  initial,
  lastUpdated,
}: WatcherReleaseFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [latestVersion, setLatestVersion] = useState(initial.latestVersion);
  const [minSupportedVersion, setMinSupportedVersion] = useState(
    initial.minSupportedVersion
  );
  const [channel, setChannel] = useState(initial.channel);
  const [mandatory, setMandatory] = useState(initial.mandatory);

  // "mandatory only takes effect with a latest_version" is enforced by the
  // server (and by the watcher's own logic). Mirror it as a derived render
  // expression here so the checkbox visibly disables when the user clears
  // the version field — no useEffect needed to keep client state in sync
  // with the rule.
  const mandatoryDisabled = latestVersion.trim().length === 0;
  const channelEmpty = channel.trim().length === 0;
  const canSubmit = !isPending && !channelEmpty;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch("/api/v1/watcher-release", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Server accepts string|null; sending the trimmed string
          // (possibly empty) lets the server's normaliser convert ""→null
          // so the wire contract stays "empty means unset" everywhere.
          latest_version: latestVersion.trim() || null,
          min_supported_version: minSupportedVersion.trim() || null,
          channel: channel.trim(),
          // The server collapses mandatory→false on read when latest_version
          // is null, so we don't need to mirror that on write — keep the
          // user's explicit choice in the row.
          mandatory,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to save watcher release");
        return;
      }

      toast.success("Watcher release saved");
      // router.refresh() re-runs the page's server component so the "last
      // updated by" line and any other server-derived UI re-renders with
      // the just-saved values — no need to thread the response back
      // into client state.
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="grid gap-2">
        <Label htmlFor="latest-version">Latest version</Label>
        <Input
          id="latest-version"
          placeholder="e.g. 0.4.2"
          value={latestVersion}
          onChange={(e) => setLatestVersion(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          The release watchers will self-upgrade to. Leave blank to temporarily
          disable self-updates (the endpoint returns{" "}
          <code className="font-mono">latest_version: null</code> and clients
          skip the upgrade).
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="min-supported-version">Minimum supported version</Label>
        <Input
          id="min-supported-version"
          placeholder="e.g. 0.1.0"
          value={minSupportedVersion}
          onChange={(e) => setMinSupportedVersion(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Optional floor surfaced in the response for future use. Not yet
          enforced server-side.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="channel">Release channel</Label>
        <Input
          id="channel"
          placeholder="stable"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Defaults to <code className="font-mono">stable</code>. Surfaced in the
          response and shown in <code className="font-mono">self-update</code>{" "}
          output.
        </p>
      </div>

      <div className="flex items-start justify-between gap-6 rounded-lg border bg-background p-4 dark:bg-muted">
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="mandatory"
            className={mandatoryDisabled ? "text-muted-foreground" : undefined}
          >
            Mandatory update
          </Label>
          <p className="text-xs text-muted-foreground">
            Skip the watcher&apos;s activity-window guard so mid-acquisition PCs
            upgrade immediately. Reserve for security fixes or wire-protocol
            breaks. Has no effect when the latest version is blank.
          </p>
        </div>
        <Switch
          id="mandatory"
          checked={mandatory && !mandatoryDisabled}
          onCheckedChange={setMandatory}
          disabled={mandatoryDisabled || isPending}
          aria-label="Toggle mandatory update"
        />
      </div>

      <div className="flex items-center justify-between gap-4 border-t pt-4">
        {lastUpdated ? (
          <p className="text-xs text-muted-foreground" suppressHydrationWarning>
            Last updated{" "}
            <span title={new Date(lastUpdated.at).toLocaleString()}>
              {formatRelativeTime(lastUpdated.at)}
            </span>
            {lastUpdated.byName || lastUpdated.byEmail ? (
              <>
                {" by "}
                <span className="font-medium text-foreground">
                  {lastUpdated.byName ?? lastUpdated.byEmail}
                </span>
              </>
            ) : null}
            .
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No release configured yet. Watchers will skip self-updates until you
            save a version.
          </p>
        )}
        <Button type="submit" disabled={!canSubmit}>
          {isPending ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : null}
          Save
        </Button>
      </div>
    </form>
  );
}

"use client";

import { CheckIcon, CircleIcon, Loader2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type TestReportProgress,
  useLinearSetup,
  useVisibleInterval,
} from "./linear-setup-context";

const WAIT_MS = 60_000;

export function TestReportStep() {
  const { goTo, sendTestReport, testReport } = useLinearSetup();
  const [issueId, setIssueId] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    identifier: string;
    labelName: string | null;
    teamName: string;
    url: string;
  } | null>(null);
  const [progress, setProgress] = useState<TestReportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    setSending(true);
    sendTestReport()
      .then((report) => {
        setIssueId(report.id);
        setCreated(report);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't send the test");
      })
      .finally(() => setSending(false));
  }, [sendTestReport]);

  useVisibleInterval(
    issueId !== null && progress?.notificationAt == null,
    2000,
    () => {
      if (!issueId) {
        return;
      }
      void testReport(issueId).then((next) => {
        setProgress(next);
        if (next.closed && closedAt === null) {
          setClosedAt(Date.now());
        }
      });
    }
  );

  useEffect(() => {
    if (
      closedAt === null ||
      progress?.updateReceived ||
      progress?.notificationAt
    ) {
      return;
    }
    const timer = window.setTimeout(() => setGaveUp(true), WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [closedAt, progress?.notificationAt, progress?.updateReceived]);

  const sent = created !== null;
  const closed = progress?.closed === true;
  const notified = Boolean(progress?.notificationAt);
  const quiet =
    progress?.updateReceived === true &&
    progress.notificationsEnabled === false;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        Data Hub files a report as you. When you close it in Linear, Data Hub
        tells you, the same way it tells anyone who sends feedback.
      </p>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {sending ? (
        <p className="inline-flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Sending the test report…
        </p>
      ) : null}
      {sent && created ? (
        <ol aria-live="polite" className="flex flex-col gap-3 text-sm">
          <CheckLine done>
            Report sent. Linear created {created.identifier} in{" "}
            {created.teamName}
            {created.labelName ? `, with the ${created.labelName} label` : ""}.
            <a
              className="ml-2 underline underline-offset-2"
              href={created.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open {created.identifier}
            </a>
          </CheckLine>
          <CheckLine done={closed}>
            {closed
              ? `${created.identifier} is ${progress?.stateName ?? "closed"}.`
              : `Waiting for ${created.identifier} to close. In Linear, move it to Done.`}
          </CheckLine>
          <CheckLine done={notified || quiet}>
            {notified
              ? "You got a Data Hub notification."
              : quiet
                ? "The update arrived, but your in-app notifications for feedback are off."
                : "You get a Data Hub notification that says Resolved (Done)."}
          </CheckLine>
        </ol>
      ) : null}
      {quiet ? (
        <Link
          className="text-sm underline underline-offset-2"
          href="/settings/notifications"
        >
          Open Notifications
        </Link>
      ) : null}
      {gaveUp && progress && !progress.updateReceived ? (
        <p className="text-sm" role="status">
          {created?.identifier} closed, but no update has arrived.
          {progress.rejections > 0
            ? ` Data Hub rejected Linear's last ${progress.rejections} ${progress.rejections === 1 ? "update" : "updates"}${progress.rejectionReason === "signature" ? " because the signing secret doesn't match" : ""}.`
            : ""}{" "}
          Linear may have turned the webhook off after repeated failures. Check
          the signing secret in step 3.
        </p>
      ) : null}
      <Button
        onClick={() => goTo(null)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Skip the test
      </Button>
    </div>
  );
}

function CheckLine({ children, done }: { children: ReactNode; done: boolean }) {
  return (
    <li className="flex gap-2">
      {done ? (
        <CheckIcon
          aria-hidden="true"
          className="mt-0.5 size-4 text-green-600"
        />
      ) : (
        <CircleIcon
          aria-hidden="true"
          className="mt-0.5 size-4 text-muted-foreground"
        />
      )}
      <span>{children}</span>
    </li>
  );
}

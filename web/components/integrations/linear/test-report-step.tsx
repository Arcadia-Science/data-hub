"use client";

import { CheckIcon, CircleIcon, Loader2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type SentTestReport,
  type TestReportProgress,
  useLinearSetup,
  useVisibleInterval,
} from "./linear-setup-context";
import { ExternalLinkButton } from "./steps";

const WAIT_MS = 60_000;

type LineState = "active" | "done" | "pending";

// Files nothing until the admin chooses to, because `?linear_step=test` stays
// in the URL and a reload would otherwise file another report.
export function TestReportStep() {
  const { actions } = useLinearSetup();
  const [sent, setSent] = useState<SentTestReport | null>(null);
  const [progress, setProgress] = useState<TestReportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  const closed = progress?.closed === true;
  const notified = Boolean(progress?.notificationAt);
  // With in-app notifications off no notification is ever written, so the
  // arrival of Linear's update is the end of the test.
  const quiet =
    progress?.updateReceived === true &&
    progress.notificationsEnabled === false;
  const finished = notified || quiet;

  async function send() {
    setSending(true);
    setError(null);
    try {
      setSent(await actions.sendTestReport());
      setProgress(null);
      setClosedAt(null);
      setGaveUp(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the test");
    } finally {
      setSending(false);
    }
  }

  useVisibleInterval(sent !== null && !finished && !gaveUp, 2000, () => {
    if (!sent) {
      return;
    }
    actions
      .testReport(sent.id)
      .then((next) => {
        setProgress(next);
        setCheckFailed(false);
        if (next.closed && closedAt === null) {
          setClosedAt(Date.now());
        }
      })
      .catch(() => setCheckFailed(true));
  });

  useEffect(() => {
    if (closedAt === null || progress?.updateReceived || finished) {
      return;
    }
    const timer = window.setTimeout(() => setGaveUp(true), WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [closedAt, finished, progress?.updateReceived]);

  const missingUpdate = gaveUp && progress !== null && !progress.updateReceived;

  return (
    <>
      <p className="text-pretty text-sm">
        Data Hub files a report as you. When you close it in Linear, Data Hub
        tells you, the same way it tells anyone who sends feedback.
      </p>
      <div aria-live="polite" className="flex flex-col gap-4">
        {sending ? (
          <p className="inline-flex items-center gap-2 text-sm">
            <Loader2
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            Sending the test report…
          </p>
        ) : null}
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        {sent ? (
          <ol aria-label="Test progress" className="flex flex-col gap-3.5">
            <CheckLine state="done">
              <p>
                <strong className="font-semibold">Report sent.</strong> Linear
                created {sent.identifier} in {sent.teamName}
                {sent.labelName ? `, with the ${sent.labelName} label` : ""}.
              </p>
              <ExternalLinkButton href={sent.url}>
                Open {sent.identifier}
              </ExternalLinkButton>
            </CheckLine>
            <CheckLine state={closed ? "done" : "active"}>
              {closed ? (
                <p>
                  {sent.identifier} is{" "}
                  {progress?.stateName ? progress.stateName : "closed"}.
                </p>
              ) : (
                <p>
                  <strong className="font-semibold">
                    Waiting for {sent.identifier} to close.
                  </strong>{" "}
                  In Linear, move it to Done.
                </p>
              )}
            </CheckLine>
            <CheckLine
              state={finished ? "done" : closed ? "active" : "pending"}
            >
              {notified ? (
                <p>You got a Data Hub notification.</p>
              ) : quiet ? (
                <>
                  <p>
                    The update arrived, but your in-app notifications for
                    feedback are off.
                  </p>
                  <Link
                    className="text-sm underline underline-offset-2 hover:text-foreground"
                    href="/settings/notifications"
                  >
                    Open Notifications
                  </Link>
                </>
              ) : (
                <p>
                  You get a Data Hub notification that says Resolved (Done).
                </p>
              )}
            </CheckLine>
          </ol>
        ) : null}
        {checkFailed && !finished ? (
          <p className="text-muted-foreground text-sm">
            Couldn't check the test. Trying again…
          </p>
        ) : null}
        {missingUpdate && progress ? (
          <div className="flex flex-col items-start gap-2 text-pretty text-sm">
            <p>
              {sent?.identifier} closed, but no update has arrived.
              {progress.rejections > 0
                ? ` Data Hub rejected Linear's last ${progress.rejections} ${progress.rejections === 1 ? "update" : "updates"}${progress.rejectionReason === "signature" ? " because the signing secret doesn't match" : ""}.`
                : ""}{" "}
              Linear may have turned the webhook off after repeated failures.
              Check the signing secret in step 3.
            </p>
            <Button
              onClick={() => {
                setGaveUp(false);
                setClosedAt(Date.now());
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Check again
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {sent ? null : (
          <Button disabled={sending} onClick={() => void send()} type="button">
            {error ? "Try again" : "Send test report"}
          </Button>
        )}
        <Button
          onClick={() => actions.goTo(null)}
          type="button"
          variant={finished ? "default" : "ghost"}
        >
          {finished ? "Done" : "Skip the test"}
        </Button>
      </div>
    </>
  );
}

const STATE_LABEL: Record<LineState, string> = {
  active: "In progress: ",
  done: "Done: ",
  pending: "Not started: ",
};

function CheckLine({
  children,
  state,
}: {
  children: ReactNode;
  state: LineState;
}) {
  return (
    <li
      className={`grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-2.5 text-sm ${state === "pending" ? "text-muted-foreground" : ""}`}
    >
      <span className="inline-flex size-5 items-center justify-center">
        {state === "done" ? (
          <CheckIcon
            aria-hidden="true"
            className="size-4 text-green-600 dark:text-green-400"
          />
        ) : state === "active" ? (
          <Loader2
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <CircleIcon aria-hidden="true" className="size-4" />
        )}
      </span>
      <div className="flex flex-col items-start gap-1.5">
        <span className="sr-only">{STATE_LABEL[state]}</span>
        {children}
      </div>
    </li>
  );
}

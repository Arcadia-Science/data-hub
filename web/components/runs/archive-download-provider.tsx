"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { ArchiveDownloadDialog } from "./archive-download-dialog";

// One in-progress archive download. Identified by `id` so the dialog can
// keep separate progress per build (e.g. bulk fan-out across runs).
//
// `archiveUrl` is the original `/download-archive` URL the user invoked.
// We re-issue it as our polling target instead of hitting
// `/api/v1/archive-jobs/:id` because the download-archive route does an
// S3 HEAD on the canonical archive key *before* doing anything else and
// 200s on a hit. That makes the artifact in S3 — not the row's status —
// the source of truth for "ready", so we recover automatically even if
// the Lambda's PATCH callback to flip the row to `ready` never lands.
export interface ArchiveDownloadJob {
  archiveUrl: string;
  defaultFilename: string;
  downloadUrl?: string;
  errorMessage?: string;
  id: string;
  // `job_id` returned by the very first 202. Subsequent polls compare
  // their own `job_id` against this; if it changes, the route's dedup
  // INSERT created a new row, which only happens after the previous
  // attempt was marked failed (or expired by the stuck-row sweep). We
  // surface that as a failure rather than silently chase a fresh build.
  initialJobId?: string;
  runId: string;
  sizeBytes?: number | null;
  startedAt: number;
  status: "pending" | "building" | "ready" | "failed";
}

interface StartArchiveDownloadInput {
  archiveUrl: string;
  defaultFilename?: string;
  runId: string;
}

export interface ArchiveDownloadActions {
  dismiss: (id: string) => void;
  start: (input: StartArchiveDownloadInput) => Promise<void>;
}

interface ArchiveDownloadContextValue {
  actions: ArchiveDownloadActions;
  jobs: ArchiveDownloadJob[];
}

export const ArchiveDownloadContext =
  createContext<ArchiveDownloadContextValue | null>(null);

const POLL_INTERVAL_MS = 2000;
// Stop polling after a generous amount of time so a stuck Lambda doesn't
// leave the dialog spinning forever. Lambda Function URLs cap at 15 minutes;
// we double that as a hard ceiling.
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

// Fire one anchor click in the current task to download a presigned URL.
// Reusing an `<a download>` rather than `window.location` keeps the run page
// in place and lets the browser pick a suitable filename.
function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Outcome of a single fetch against `/download-archive`. Both the initial
// click and the polling effect parse the response into one of these so the
// state-update logic is shared.
type ProbeResult =
  | { kind: "ready"; downloadUrl: string; sizeBytes: number | null }
  | { kind: "building"; jobId: string }
  | { kind: "redirect"; url: string }
  | { kind: "failed"; message: string };

// Fetch `/download-archive` with `Accept: application/json` and translate
// the response into a `ProbeResult`. Both `start()` (initial click) and
// the polling effect use this — there is no separate "is the build
// finished?" endpoint. The route's S3 HEAD short-circuit means a finished
// build is visible to us regardless of whether the Lambda's PATCH callback
// to the web app fired.
//
// `redirect: "manual"` is intentional: when the caller doesn't (or can't)
// honor the JSON Accept and 302s straight to S3, we don't want `fetch`
// to silently follow into binary bytes; we want to detect the redirect
// and either navigate the page (initial click) or ignore it (polling).
async function probeArchiveUrl(archiveUrl: string): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch(archiveUrl, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      cache: "no-store",
    });
  } catch (err) {
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : "Network request failed",
    };
  }

  // `redirect: "manual"` surfaces a 3xx as an opaque redirect rather than
  // following it. The route only returns a 302 if the client didn't ask
  // for JSON — we always do — so reaching here usually means an
  // intermediary stripped the Accept header. Fall back to a navigation.
  if (res.type === "opaqueredirect") {
    return { kind: "redirect", url: archiveUrl };
  }

  if (!res.ok && res.status !== 202) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      kind: "failed",
      message:
        body?.error?.message ?? `Archive download failed (${res.status})`,
    };
  }

  const body = (await res.json().catch(() => null)) as {
    status?: "ready" | "building";
    download_url?: string;
    size_bytes?: number | null;
    job_id?: string;
  } | null;
  if (!body) {
    return {
      kind: "failed",
      message: "Archive route returned a malformed response",
    };
  }

  if (body.status === "ready" && body.download_url) {
    return {
      kind: "ready",
      downloadUrl: body.download_url,
      sizeBytes: body.size_bytes ?? null,
    };
  }

  if (!body.job_id) {
    return {
      kind: "failed",
      message: "Archive route did not return a job id",
    };
  }

  return { kind: "building", jobId: body.job_id };
}

export function ArchiveDownloadProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ArchiveDownloadJob[]>([]);
  // Persist the latest jobs in a ref so polling closures don't capture stale
  // state when the user opens multiple downloads in quick succession. Mirror
  // the state into the ref via an effect (rather than during render) so React
  // strict-mode double-invocation can't cause torn updates.
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const updateJob = useCallback(
    (id: string, patch: Partial<ArchiveDownloadJob>) => {
      setJobs((prev) =>
        prev.map((j) => (j.id === id ? { ...j, ...patch } : j))
      );
    },
    []
  );

  const dismiss = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  // Mark a job ready, kick the browser into the download, and schedule
  // auto-dismiss. Centralised so the initial click and the polling effect
  // produce identical state transitions.
  const completeReady = useCallback(
    (
      id: string,
      filename: string,
      downloadUrl: string,
      sizeBytes: number | null
    ) => {
      updateJob(id, { status: "ready", downloadUrl, sizeBytes });
      triggerDownload(downloadUrl, filename);
      // Auto-dismiss the row a moment later so the dialog doesn't linger
      // when the build was actually a cache hit.
      window.setTimeout(() => dismiss(id), 1500);
    },
    [dismiss, updateJob]
  );

  const start = useCallback<ArchiveDownloadActions["start"]>(
    async ({ archiveUrl, runId, defaultFilename }) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      const filename = defaultFilename ?? `${runId}.zip`;
      setJobs((prev) => [
        ...prev,
        {
          id,
          runId,
          archiveUrl,
          defaultFilename: filename,
          status: "pending",
          startedAt: Date.now(),
        },
      ]);

      const result = await probeArchiveUrl(archiveUrl);

      switch (result.kind) {
        case "redirect":
          window.location.href = result.url;
          dismiss(id);
          return;
        case "ready":
          completeReady(id, filename, result.downloadUrl, result.sizeBytes);
          return;
        case "failed":
          updateJob(id, { status: "failed", errorMessage: result.message });
          return;
        case "building":
          updateJob(id, {
            status: "building",
            initialJobId: result.jobId,
          });
          return;
      }
    },
    [completeReady, dismiss, updateJob]
  );

  // Poll any building job by re-issuing the original `/download-archive`
  // URL (NOT `/api/v1/archive-jobs/:id`). The route's S3 HEAD short-circuit
  // is the canonical "is it ready?" signal — much more robust than reading
  // the row's status, which only flips after the Lambda's PATCH callback
  // succeeds. A single shared interval handles all in-flight jobs so we
  // don't spin up N timers.
  useEffect(() => {
    const building = jobs.filter((j) => j.status === "building");
    if (building.length === 0) {
      return;
    }

    const interval = window.setInterval(async () => {
      for (const job of jobsRef.current) {
        if (job.status !== "building") {
          continue;
        }
        if (Date.now() - job.startedAt > POLL_TIMEOUT_MS) {
          updateJob(job.id, {
            status: "failed",
            errorMessage:
              "Build is taking longer than expected. Try again later.",
          });
          continue;
        }

        const result = await probeArchiveUrl(job.archiveUrl);
        switch (result.kind) {
          case "ready":
            completeReady(
              job.id,
              job.defaultFilename,
              result.downloadUrl,
              result.sizeBytes
            );
            toast.success(`Downloading ${job.runId}...`);
            break;
          case "failed":
            updateJob(job.id, {
              status: "failed",
              errorMessage: result.message,
            });
            break;
          case "building":
            // A different `job_id` than the one we got at start time means
            // the previous attempt was marked failed (or aged out via the
            // stuck-row sweep) and the route's dedup INSERT created a
            // fresh row to start a new build. Surface that to the user
            // instead of silently chasing a build that already failed
            // once — they can retry explicitly if they want another shot.
            if (job.initialJobId && result.jobId !== job.initialJobId) {
              updateJob(job.id, {
                status: "failed",
                errorMessage:
                  "The previous build attempt failed. Click Download again to retry.",
              });
            }
            // Otherwise: same job_id, still building — keep polling.
            break;
          case "redirect":
            // Polling is a background activity; don't navigate the user.
            // Try again on the next interval — by then the route will
            // hopefully be honoring the JSON Accept header again.
            break;
        }
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [jobs, completeReady, updateJob]);

  const value = useMemo(
    () => ({ jobs, actions: { start, dismiss } }),
    [jobs, start, dismiss]
  );

  return (
    <ArchiveDownloadContext.Provider value={value}>
      {children}
      <ArchiveDownloadDialog jobs={jobs} onDismiss={dismiss} />
    </ArchiveDownloadContext.Provider>
  );
}

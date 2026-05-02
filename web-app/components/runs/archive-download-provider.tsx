"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { ArchiveDownloadDialog } from "./archive-download-dialog";

// One in-progress archive download. Identified by `id` so the dialog can
// keep separate progress per build (e.g. bulk fan-out across runs).
export type ArchiveDownloadJob = {
  id: string;
  runId: string;
  jobId?: string;
  pollUrl?: string;
  status: "pending" | "building" | "ready" | "failed";
  errorMessage?: string;
  downloadUrl?: string;
  sizeBytes?: number | null;
  startedAt: number;
};

type StartArchiveDownloadInput = {
  archiveUrl: string;
  runId: string;
  defaultFilename?: string;
};

export type ArchiveDownloadActions = {
  start: (input: StartArchiveDownloadInput) => Promise<void>;
  dismiss: (id: string) => void;
};

type ArchiveDownloadContextValue = {
  jobs: ArchiveDownloadJob[];
  actions: ArchiveDownloadActions;
};

export const ArchiveDownloadContext =
  createContext<ArchiveDownloadContextValue | null>(null);

const POLL_INTERVAL_MS = 2_000;
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

  const start = useCallback<ArchiveDownloadActions["start"]>(
    async ({ archiveUrl, runId, defaultFilename }) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      setJobs((prev) => [
        ...prev,
        {
          id,
          runId,
          status: "pending",
          startedAt: Date.now(),
        },
      ]);

      let res: Response;
      try {
        res = await fetch(archiveUrl, {
          headers: { Accept: "application/json" },
          // Direct nav would 302 — we want the JSON envelope so we can poll.
          redirect: "manual",
        });
      } catch (err) {
        updateJob(id, {
          status: "failed",
          errorMessage:
            err instanceof Error ? err.message : "Network request failed",
        });
        return;
      }

      // Some browsers return `type === "opaqueredirect"` when redirect is
      // manual — that means the route 302'd directly, so just open the URL.
      if (res.type === "opaqueredirect") {
        window.location.href = archiveUrl;
        dismiss(id);
        return;
      }

      if (!res.ok && res.status !== 202) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        updateJob(id, {
          status: "failed",
          errorMessage:
            body?.error?.message ?? `Archive download failed (${res.status})`,
        });
        return;
      }

      const body = (await res.json().catch(() => null)) as {
        status?: "ready" | "building";
        download_url?: string;
        size_bytes?: number | null;
        job_id?: string;
        poll_url?: string;
      } | null;
      if (!body) {
        updateJob(id, {
          status: "failed",
          errorMessage: "Archive route returned a malformed response",
        });
        return;
      }

      if (body.status === "ready" && body.download_url) {
        updateJob(id, {
          status: "ready",
          downloadUrl: body.download_url,
          sizeBytes: body.size_bytes ?? null,
        });
        triggerDownload(body.download_url, defaultFilename ?? `${runId}.zip`);
        // Auto-dismiss the row a moment later so the dialog doesn't linger
        // when the build was actually a cache hit.
        window.setTimeout(() => dismiss(id), 1_500);
        return;
      }

      if (!body.job_id) {
        updateJob(id, {
          status: "failed",
          errorMessage: "Archive route did not return a job id",
        });
        return;
      }

      updateJob(id, {
        status: "building",
        jobId: body.job_id,
        pollUrl: body.poll_url ?? `/api/v1/archive-jobs/${body.job_id}`,
      });
    },
    [dismiss, updateJob]
  );

  // Poll any building job until it reaches a terminal state. Single shared
  // interval handles all in-flight jobs so we don't spin up N timers.
  useEffect(() => {
    const building = jobs.filter((j) => j.status === "building");
    if (building.length === 0) return;

    const interval = window.setInterval(async () => {
      for (const job of jobsRef.current) {
        if (job.status !== "building" || !job.pollUrl) continue;
        if (Date.now() - job.startedAt > POLL_TIMEOUT_MS) {
          updateJob(job.id, {
            status: "failed",
            errorMessage:
              "Build is taking longer than expected. Try again later.",
          });
          continue;
        }
        try {
          const res = await fetch(job.pollUrl, {
            headers: { Accept: "application/json" },
          });
          if (!res.ok) continue;
          const body = (await res.json().catch(() => null)) as {
            status?: string;
            download_url?: string;
            size_bytes?: number | null;
            error_message?: string;
          } | null;
          if (!body) continue;
          if (body.status === "ready" && body.download_url) {
            updateJob(job.id, {
              status: "ready",
              downloadUrl: body.download_url,
              sizeBytes: body.size_bytes ?? null,
            });
            triggerDownload(body.download_url, `${job.runId}.zip`);
            toast.success(`Archive for ${job.runId} is ready`);
            window.setTimeout(() => dismiss(job.id), 1_500);
          } else if (body.status === "failed") {
            updateJob(job.id, {
              status: "failed",
              errorMessage:
                body.error_message ?? "Archive build failed on the server",
            });
          }
        } catch {
          // Transient network failure — keep polling.
        }
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [jobs, dismiss, updateJob]);

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

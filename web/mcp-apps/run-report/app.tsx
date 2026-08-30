import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReportDataSourceProvider } from "@/components/runs/report-data-source-provider";
import { RunSectionActionsProvider } from "@/components/runs/run-section-heading";
import { runDetailUrl } from "./data-hub-origin";
import {
  persistKey,
  useContainerDimensions,
  useDarkClass,
  useOpenLinkInterceptor,
} from "./host-bridge";
import {
  InstrumentReport,
  type RunReportToolResult,
} from "./instrument-report";
import { createMcpReportDataSource } from "./mcp-data-source";
import { parseRunReportToolResult } from "./parse-tool-result";

export function RunReportApp() {
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const { app, error } = useApp({
    appInfo: { name: "data-hub-run-report", version: "0.0.0" },
    capabilities: {
      availableDisplayModes: ["inline", "fullscreen"],
    },
    onAppCreated: (created) => {
      created.ontoolresult = (result) => {
        setCancelled(false);
        setToolResult(result);
      };
      created.ontoolcancelled = () => {
        setCancelled(true);
      };
      created.onerror = console.error;
    },
  });

  useHostStyles(app, app?.getHostContext());
  useContainerDimensions(app);
  useDarkClass();

  if (error) {
    return (
      <p className="p-4 text-destructive text-sm">
        Failed to connect: {error.message}
      </p>
    );
  }
  if (!app) {
    return <p className="p-4 text-muted-foreground text-sm">Connecting…</p>;
  }
  if (cancelled) {
    return (
      <p className="p-4 text-muted-foreground text-sm">
        Report load was stopped.
      </p>
    );
  }
  if (!toolResult) {
    return (
      <p className="p-4 text-muted-foreground text-sm">Waiting for run…</p>
    );
  }

  const parsed = parseRunReportToolResult(toolResult);
  if (!parsed) {
    return (
      <p className="p-4 text-destructive text-sm">
        Run report result was missing instrument or run identifiers.
      </p>
    );
  }

  return <ConnectedReport app={app} result={parsed} />;
}

function ConnectedReport({
  app,
  result,
}: {
  app: App;
  result: RunReportToolResult;
}) {
  const dataSource = useMemo(
    () =>
      createMcpReportDataSource({
        app,
        instrumentId: result.instrumentId,
        runId: result.runId,
      }),
    [app, result.instrumentId, result.runId]
  );
  const storageKey = persistKey(result.instrumentId, result.runId);
  const [displayMode, setDisplayMode] = useState(
    () => app.getHostContext()?.displayMode ?? "inline"
  );
  const [linkFallback, setLinkFallback] = useState<string | null>(null);

  useOpenLinkInterceptor(app, setLinkFallback);

  useEffect(() => {
    const apply = () => {
      const mode = app.getHostContext()?.displayMode;
      if (mode === "inline" || mode === "fullscreen") {
        setDisplayMode(mode);
      }
    };
    apply();
    app.addEventListener("hostcontextchanged", apply);
    return () => {
      app.removeEventListener("hostcontextchanged", apply);
    };
  }, [app]);

  const toggleFullscreen = useCallback(async () => {
    const hostModes = app.getHostContext()?.availableDisplayModes ?? [];
    const next = displayMode === "inline" ? "fullscreen" : "inline";
    if (!hostModes.includes(next)) {
      return;
    }
    try {
      const response = await app.requestDisplayMode({ mode: next });
      setDisplayMode(response.mode);
    } catch {
      // Host refused or timed out; keep the last known mode.
    }
  }, [app, displayMode]);

  const canToggle = (
    app.getHostContext()?.availableDisplayModes ?? []
  ).includes(displayMode === "inline" ? "fullscreen" : "inline");

  const openInDataHub = (
    <a
      className="inline-flex items-center gap-1.5 font-semibold text-sm hover:underline"
      href={runDetailUrl(result.instrumentId, result.runId)}
      rel="noopener noreferrer"
      target="_blank"
    >
      Open in Data Hub
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 p-3">
      {canToggle ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            className="rounded-md border px-2 py-1 text-sm"
            onClick={() => {
              void toggleFullscreen().catch(() => {
                // Host refused or timed out; keep the last known mode.
              });
            }}
            type="button"
          >
            {displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"}
          </button>
        </div>
      ) : null}
      {linkFallback ? (
        <p className="break-all text-muted-foreground text-xs">
          {linkFallback}
        </p>
      ) : null}
      <RunSectionActionsProvider actions={openInDataHub}>
        <ReportDataSourceProvider dataSource={dataSource}>
          <InstrumentReport persistKey={storageKey} result={result} />
        </ReportDataSourceProvider>
      </RunSectionActionsProvider>
    </div>
  );
}

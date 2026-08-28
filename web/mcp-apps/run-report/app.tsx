import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useCallback, useMemo, useState } from "react";
import { ReportDataSourceProvider } from "@/components/runs/report-data-source-provider";
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

function structuredToolResult(
  result: CallToolResult
): RunReportToolResult | null {
  const payload = result.structuredContent;
  if (payload && typeof payload === "object") {
    const record = payload as Partial<RunReportToolResult>;
    if (record.instrumentId && record.runId && record.instrumentType) {
      return {
        instrumentId: record.instrumentId,
        runId: record.runId,
        instrumentType: record.instrumentType,
        metadata: record.metadata,
        reportFiles: record.reportFiles ?? [],
      };
    }
  }
  const text = result.content?.find((block) => block.type === "text");
  if (text && "text" in text) {
    try {
      return structuredToolResult({
        ...result,
        structuredContent: JSON.parse(text.text),
      });
    } catch {
      return null;
    }
  }
  return null;
}

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
  useOpenLinkInterceptor(app);

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

  const parsed = structuredToolResult(toolResult);
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

  const openRun = useCallback(async () => {
    const url = runDetailUrl(result.instrumentId, result.runId);
    if (app.getHostCapabilities()?.openLinks) {
      const response = await app.openLink({ url });
      if (response.isError) {
        setLinkFallback(url);
      }
      return;
    }
    setLinkFallback(url);
  }, [app, result.instrumentId, result.runId]);

  const toggleFullscreen = useCallback(async () => {
    const hostModes = app.getHostContext()?.availableDisplayModes ?? [];
    const next = displayMode === "inline" ? "fullscreen" : "inline";
    if (!hostModes.includes(next)) {
      return;
    }
    const response = await app.requestDisplayMode({ mode: next });
    setDisplayMode(response.mode);
  }, [app, displayMode]);

  const canToggle = (
    app.getHostContext()?.availableDisplayModes ?? []
  ).includes(displayMode === "inline" ? "fullscreen" : "inline");

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-md border px-2 py-1 text-sm"
          onClick={() => void openRun()}
          type="button"
        >
          Open in Data Hub
        </button>
        {canToggle ? (
          <button
            className="rounded-md border px-2 py-1 text-sm"
            onClick={() => void toggleFullscreen()}
            type="button"
          >
            {displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"}
          </button>
        ) : null}
      </div>
      {linkFallback ? (
        <p
          className="break-all text-muted-foreground text-xs"
          id="open-link-fallback"
        >
          {linkFallback}
        </p>
      ) : (
        <p hidden id="open-link-fallback" />
      )}
      <ReportDataSourceProvider dataSource={dataSource}>
        <InstrumentReport persistKey={storageKey} result={result} />
      </ReportDataSourceProvider>
    </div>
  );
}

"use client";

import { createContext, type ReactNode, use, useEffect, useRef } from "react";
import type { FeedbackKind } from "@/lib/api/feedback-schema";

export type LinearStep = "connect" | "destination" | "test" | "updates";

export interface SetupChoice {
  id: string;
  key?: string;
  name: string;
  url?: string;
}

export type SetupLabels = Record<FeedbackKind, SetupChoice | null>;

export interface LinearSetupData {
  clientId: string | null;
  clientSecretSet: boolean;
  keyStatus: "invalid" | "missing" | "ok";
  labels: SetupLabels;
  lastUpdatedAt: string | null;
  lastUpdatedBy: string | null;
  lastWebhookAt: string | null;
  origin: string;
  project: SetupChoice | null;
  rejectionReason: "signature" | "stale" | null;
  team: SetupChoice | null;
  webhookRejections: number;
  webhookSecretSet: boolean;
  webhookUrl: string;
  workspaceName: string | null;
}

export interface ConnectFailure {
  code: string;
  message: string;
  workspaceName?: string;
}

export interface LinearOptions {
  labels: SetupChoice[];
  projects: SetupChoice[];
  teams: SetupChoice[];
}

export interface TestReportProgress {
  closed: boolean;
  identifier: string;
  labelName: string | null;
  notificationAt: string | null;
  notificationsEnabled: boolean;
  rejectionReason: "signature" | "stale" | null;
  rejections: number;
  stateName: string;
  teamName: string;
  updateReceived: boolean;
  url: string;
}

interface LinearSetupActions {
  connect: (input: {
    clientId: string;
    clientSecret: string;
    confirmWorkspaceChange?: boolean;
  }) => Promise<ConnectFailure | null>;
  data: LinearSetupData;
  disconnect: () => Promise<void>;
  goTo: (step: LinearStep | null) => void;
  loadOptions: (teamId: string | null) => Promise<LinearOptions>;
  refresh: () => Promise<void>;
  saveDestination: (input: {
    labels: SetupLabels;
    project: SetupChoice | null;
    team: SetupChoice | null;
  }) => Promise<void>;
  saveSigningSecret: (secret: string) => Promise<void>;
  sendTestReport: () => Promise<{
    id: string;
    identifier: string;
    labelName: string | null;
    teamName: string;
    url: string;
  }>;
  step: LinearStep | "blocked" | "summary";
  testReport: (id: string) => Promise<TestReportProgress>;
}

const LinearSetupContext = createContext<LinearSetupActions | null>(null);

export function LinearSetupProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: LinearSetupActions;
}) {
  return (
    <LinearSetupContext.Provider value={value}>
      {children}
    </LinearSetupContext.Provider>
  );
}

export function useLinearSetup(): LinearSetupActions {
  const value = use(LinearSetupContext);
  if (!value) {
    throw new Error("Linear setup steps need LinearSetupProvider.");
  }
  return value;
}

// Polls while the tab is visible and stops when the caller turns it off.
export function useVisibleInterval(
  enabled: boolean,
  intervalMs: number,
  tick: () => void
) {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let timer: number | undefined;
    const start = () => {
      timer = window.setInterval(() => tickRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      tickRef.current();
      start();
    };
    if (document.visibilityState !== "hidden") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs]);
}

import { createSerializer } from "nuqs/server";
import { NEEDS_ATTENTION_RUN_STATUSES } from "@/lib/runs/run-status";
import { ALL_TIME_DATE_FROM, dashboardSearchParams } from "@/lib/search-params";

const serializeRuns = createSerializer(dashboardSearchParams);

// The runs list filtered to runs that need someone to act: the dashboard's,
// or a member's profile when `userId` is given. The dashboard lists today's
// runs unless the URL says otherwise, so its link asks for all time.
export function runsNeedingAttentionHref(userId?: string): string {
  const status = [...NEEDS_ATTENTION_RUN_STATUSES];
  const href = userId
    ? serializeRuns(`/users/${userId}`, { status })
    : serializeRuns("/", { status, date_from: ALL_TIME_DATE_FROM });
  return `${href}#runs`;
}

"use client";

import { createContext, type ReactNode, use } from "react";
import { getBrowserTimeZone } from "@/lib/date";

const ViewerTimeZoneContext = createContext<string | null>(null);

/**
 * Carries the viewer's timezone (from the `timezone` cookie, read on the
 * server) to client components. Rendering with the same zone on the server and
 * in the browser keeps formatted dates identical, so hydration doesn't see a
 * mismatch.
 */
export function ViewerTimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: ReactNode;
}) {
  return (
    <ViewerTimeZoneContext value={timeZone}>{children}</ViewerTimeZoneContext>
  );
}

/**
 * The viewer's IANA timezone. Outside a provider (a unit test, an embedded
 * view) it falls back to the browser's zone, which matches the old behavior.
 */
export function useViewerTimeZone(): string {
  return use(ViewerTimeZoneContext) ?? getBrowserTimeZone();
}

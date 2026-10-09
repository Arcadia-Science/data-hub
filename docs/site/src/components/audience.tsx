import type { ReactNode } from "react";

// A small pill rendered at the top of a page to signal who it's written for.
// Keeps the audience-mixing problem visible: a lab operator and an ops engineer
// can tell at a glance whether a page is meant for them.
export function Audience({ children }: { children: ReactNode }) {
  return (
    <div className="not-prose mb-6 inline-flex items-center gap-1.5 rounded-full border border-fd-border bg-fd-secondary px-3 py-1 font-medium text-fd-secondary-foreground text-xs">
      <span className="text-fd-muted-foreground">For</span>
      {children}
    </div>
  );
}

"use client";

import { FeedbackProvider } from "@arcadia-science/app-feedback/react";
import type { ReactNode } from "react";
import { FEEDBACK_APP } from "@/lib/feedback-app";

// Data Hub's pages are `/instruments/<name>/runs/<id>`, so a report sent from
// one can name the instrument and run instead of just the last path segment.
function describePage(segments: string[]): string | null {
  if (segments[0] !== "instruments" || !segments[1]) {
    return null;
  }
  const name = humanizeSlug(segments[1]);
  if (segments[2] === "runs" && segments[3]) {
    return `${name}, run ${segments[3]}`;
  }
  return name;
}

function humanizeSlug(slug: string): string {
  const words = decodeURIComponent(slug).replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A client file because `describePage` is a function, which cannot be passed
// from a server component.
export function DataHubFeedbackProvider({ children }: { children: ReactNode }) {
  return (
    <FeedbackProvider
      appName={FEEDBACK_APP.appName}
      describePage={describePage}
      feedbackUrl="/api/v1/feedback"
      linearUrl="/api/v1/settings/integrations/linear"
      notificationsHref="/settings/notifications"
      sendHint="Problems with a specific run belong in a comment on that run."
    >
      {children}
    </FeedbackProvider>
  );
}

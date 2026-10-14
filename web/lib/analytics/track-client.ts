import { track } from "@vercel/analytics";
import type {
  AnalyticsEventName,
  AnalyticsEvents,
} from "@/lib/analytics/track";

// Browser counterpart of `trackEvent`. Only the event catalog is imported so
// the server-only code in `track.ts` stays out of the client bundle.
export function trackClientEvent<N extends AnalyticsEventName>(
  name: N,
  props: AnalyticsEvents[N]
): void {
  try {
    track(name, props as Record<string, string | number | boolean | null>);
  } catch {
    // Analytics must never break the page.
  }
}

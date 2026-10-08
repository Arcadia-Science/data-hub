import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// Linear posts here when an issue changes. The feedback package checks the
// signature, then tells the reporter through `onReportClosed` in `lib/feedback`.
export const { POST } = createFeedbackHandlers(feedback).linearWebhook;

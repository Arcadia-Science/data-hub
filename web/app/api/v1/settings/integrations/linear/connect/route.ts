import { createFeedbackHandlers } from "@arcadiascience/app-feedback-toolkit/next";
import { feedback } from "@/lib/feedback";

// Checks the Linear credentials before saving them. Owned by the feedback package.
export const { POST } = createFeedbackHandlers(feedback).linearConnect;

import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// Checks the Linear credentials before saving them. Owned by the feedback package.
export const { POST } = createFeedbackHandlers(feedback).linearConnect;

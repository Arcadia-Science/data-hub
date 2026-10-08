import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// Sending and listing reports. The feedback package owns the logic. A report
// belongs to the person who wrote it, so only a browser session is accepted.
export const { GET, POST } = createFeedbackHandlers(feedback).feedback;

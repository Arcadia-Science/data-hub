import { createFeedbackHandlers } from "@arcadiascience/app-feedback-toolkit/next";
import { feedback } from "@/lib/feedback";

// Sending and listing reports. `getViewer` in `lib/feedback` decides who can
// call these.
export const { GET, POST } = createFeedbackHandlers(feedback).feedback;

import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// Sending and listing reports. `getViewer` in `lib/feedback` decides who can
// call these.
export const { GET, POST } = createFeedbackHandlers(feedback).feedback;

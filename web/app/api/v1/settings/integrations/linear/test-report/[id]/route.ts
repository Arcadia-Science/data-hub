import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// How far the setup wizard's test report has got.
export const { GET } = createFeedbackHandlers(feedback).linearTestReportStatus;

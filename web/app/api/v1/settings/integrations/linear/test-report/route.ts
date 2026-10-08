import { createFeedbackHandlers } from "@arcadiascience/app-feedback-toolkit/next";
import { feedback } from "@/lib/feedback";

// Files the setup wizard's test report.
export const { POST } = createFeedbackHandlers(feedback).linearTestReport;

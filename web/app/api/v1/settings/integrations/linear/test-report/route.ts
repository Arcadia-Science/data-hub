import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// Files the setup wizard's test report.
export const { POST } = createFeedbackHandlers(feedback).linearTestReport;

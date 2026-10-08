import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// Linear stores this URL on the feedback issue. Opening it lands on the report
// in Data Hub. The path also lets Data Hub find one person's reports by
// searching Linear for the URL.
export const { GET } = createFeedbackHandlers(feedback, {
  reviewPath: "/settings/feedback",
}).reportRedirect;

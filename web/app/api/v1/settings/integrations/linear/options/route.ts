import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// Lists the Linear teams, projects, and labels the setup wizard offers.
export const { GET } = createFeedbackHandlers(feedback).linearOptions;

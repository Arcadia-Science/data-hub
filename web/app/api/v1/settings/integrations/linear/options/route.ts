import { createFeedbackHandlers } from "@arcadiascience/app-feedback-toolkit/next";
import { feedback } from "@/lib/feedback";

// Lists the Linear teams, projects, and labels the setup wizard offers.
export const { GET } = createFeedbackHandlers(feedback).linearOptions;

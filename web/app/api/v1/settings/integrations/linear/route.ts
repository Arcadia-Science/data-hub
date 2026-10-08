import { createFeedbackHandlers } from "@arcadia-science/app-feedback/next";
import { feedback } from "@/lib/feedback";

// Admin-only Linear app settings, owned by the feedback package.
export const { DELETE, GET, PUT } =
  createFeedbackHandlers(feedback).linearSettings;

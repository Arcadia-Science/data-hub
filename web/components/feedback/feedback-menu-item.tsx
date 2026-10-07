"use client";

import { MessageSquarePlus } from "lucide-react";
import { useFeedbackDialog } from "@/components/feedback/feedback-dialog-provider";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function FeedbackMenuItem() {
  const feedback = useFeedbackDialog();
  return (
    <DropdownMenuItem onSelect={feedback.open}>
      <MessageSquarePlus data-icon="inline-start" />
      Feedback
    </DropdownMenuItem>
  );
}

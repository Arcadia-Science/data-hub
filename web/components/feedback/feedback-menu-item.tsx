"use client";

import { useOpenFeedback } from "@arcadiascience/app-feedback-toolkit/react";
import { MessageSquarePlus } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function FeedbackMenuItem() {
  const openFeedback = useOpenFeedback();
  return (
    <DropdownMenuItem onSelect={openFeedback}>
      <MessageSquarePlus data-icon="inline-start" />
      Feedback
    </DropdownMenuItem>
  );
}

"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import { SendFeedbackDialog } from "@/components/feedback/send-feedback-dialog";

const FeedbackDialogContext = createContext<{ open: () => void } | null>(null);

// Owns the dialog's open state. The menu item that opens it lives inside a
// dropdown that unmounts when it closes, so the dialog has to sit above it.
export function FeedbackDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <FeedbackDialogContext value={{ open: () => setOpen(true) }}>
      {children}
      <SendFeedbackDialog onOpenChange={setOpen} open={open} />
    </FeedbackDialogContext>
  );
}

export function useFeedbackDialog() {
  const context = useContext(FeedbackDialogContext);
  if (!context) {
    throw new Error("useFeedbackDialog needs a FeedbackDialogProvider.");
  }
  return context;
}

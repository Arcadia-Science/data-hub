"use client";

import { Plus } from "lucide-react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";

// Shown to non-admins in place of `CreateTokenDialog` so the create form
// never enters the React tree or client bundle for users who can't mint PATs.
export function CreateTokenDisabledButton() {
  return (
    <DisabledReasonButton
      reason="Ask an admin to create a token for you"
      size="sm"
    >
      <Plus data-icon="inline-start" />
      Create token
    </DisabledReasonButton>
  );
}

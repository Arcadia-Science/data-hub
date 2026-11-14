"use client";

import { use } from "react";
import {
  type ClaimPromptActions,
  ClaimPromptContext,
} from "@/components/runs/claim-prompt/claim-prompt-provider";

const NO_PROMPT: ClaimPromptActions = {
  ask() {
    // Outside the signed-in app shell, such as in MCP App views, nobody is
    // there to ask.
  },
};

// Asks whether the person ran the runs they just downloaded. Unlike
// `useArchiveDownload`, this does nothing outside its provider, because a
// missing prompt never loses the person's work.
export function useClaimPrompt(): ClaimPromptActions {
  return use(ClaimPromptContext) ?? NO_PROMPT;
}

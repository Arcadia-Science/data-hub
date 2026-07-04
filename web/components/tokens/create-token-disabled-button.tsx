"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Shown to non-admins in place of `CreateTokenDialog` so the create form
// never enters the React tree or client bundle for users who can't mint PATs.
export function CreateTokenDisabledButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>
          <Button className="pointer-events-none" disabled size="sm">
            <Plus data-icon="inline-start" />
            Create token
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs" side="top">
        Ask an admin to create a token for you
      </TooltipContent>
    </Tooltip>
  );
}

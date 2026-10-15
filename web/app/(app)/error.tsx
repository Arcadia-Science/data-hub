"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

// Without this file, an error while rendering a page replaces the sidebar and
// header with Next's default error screen. Here only the page content is
// replaced, so the user can still navigate away.
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 p-12 text-center"
      role="alert"
    >
      <h1 className="font-semibold text-lg tracking-tight">
        Something Went Wrong
      </h1>
      <p className="text-muted-foreground text-sm">
        This page failed to load. Try again, and reload the page if it keeps
        happening.
      </p>
      <Button onClick={retry}>Try Again</Button>
    </div>
  );
}

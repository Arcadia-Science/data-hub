"use client";

import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface LoadErrorBoundaryProps {
  children: ReactNode;
  // Shown instead of the default message. Pass `null` to show nothing.
  fallback?: ReactNode;
  onError?: (error: Error) => void;
}

/**
 * Catches a lazy chunk that fails to download, for example on a flaky network
 * or right after a deploy, so one broken menu does not replace the whole page
 * with the error screen. A failed `lazy` import stays failed until the page
 * reloads, so the default message offers a reload instead of a retry.
 */
export class LoadErrorBoundary extends Component<
  LoadErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }
    return (
      <div
        className="flex flex-col items-center gap-2 p-4 text-center"
        role="alert"
      >
        <p className="text-muted-foreground text-sm">{"Couldn’t load this."}</p>
        <Button
          onClick={() => window.location.reload()}
          size="sm"
          variant="outline"
        >
          Reload Page
        </Button>
      </div>
    );
  }
}

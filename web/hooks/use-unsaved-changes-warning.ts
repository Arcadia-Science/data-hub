import { useEffect } from "react";

/**
 * Makes the browser ask before the page is reloaded, closed, or left for
 * another site while a form holds changes that were not saved.
 *
 * Browsers do not let a page block links inside the app, so Next.js
 * navigation is not covered. Save buttons stay disabled until something
 * changes, which keeps the common case visible.
 */
export function useUnsavedChangesWarning(hasUnsavedChanges: boolean) {
  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }

    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Older Chrome only shows the prompt when `returnValue` is set.
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedChanges]);
}

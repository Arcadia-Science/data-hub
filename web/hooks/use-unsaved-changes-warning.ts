import { useEffect } from "react";

/**
 * Makes the browser ask before the page is reloaded, closed, or left for
 * another site while a form holds changes that were not saved.
 *
 * A link between pages inside the app never unloads the document, so no
 * `beforeunload` event fires, and Next.js has no hook to block those links.
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

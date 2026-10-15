import { useRef } from "react";

/**
 * Props for a Radix dialog's content that return focus to the control that
 * opened it. Radix does this only for a registered trigger, so a dialog opened
 * from state, such as by a switch or a button handler, would otherwise drop
 * focus on the page body when it closes.
 */
export function useReturnFocus() {
  const openerRef = useRef<HTMLElement | null>(null);

  return {
    onOpenAutoFocus() {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
    },
    onCloseAutoFocus(event: Event) {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) {
        // Skips Radix's own handler, which would focus a missing trigger.
        event.preventDefault();
        opener.focus();
      }
    },
  };
}

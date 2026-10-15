import { useRef } from "react";

/**
 * Props for a Radix dialog's content that return focus to the control that
 * opened it. Radix does this only for a registered trigger, so a dialog opened
 * from state, such as by a switch or a button handler, would otherwise drop
 * focus on the page body when it closes.
 *
 * `resolveTarget` can pick another element near the opener, for a dialog whose
 * content steps between items and should land on the last one shown.
 */
export function useReturnFocus(
  resolveTarget?: (opener: HTMLElement) => HTMLElement | null
) {
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
      const target = (opener && resolveTarget?.(opener)) || opener;
      if (target?.isConnected) {
        // Skips Radix's own handler, which would focus a missing trigger.
        event.preventDefault();
        target.focus();
      }
    },
  };
}

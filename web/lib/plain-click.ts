/**
 * True for a plain left click that nothing else has handled. Modified clicks
 * (Cmd, Ctrl, Shift, Alt) and middle clicks should reach the browser so it can
 * open the link in a new tab or window.
 */
export function isPlainLeftClick(event: {
  button: number;
  defaultPrevented?: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

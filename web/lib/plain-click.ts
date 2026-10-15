/**
 * True for a plain left click. Modified clicks (Cmd, Ctrl, Shift, Alt) and
 * middle clicks should reach the browser so it can open the link in a new tab
 * or window.
 */
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

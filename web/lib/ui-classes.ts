// Class names shared by components that must look alike. They live in a plain
// module, not a "use client" one, so server components can import them as
// strings.

/**
 * The gray of the file pattern badges. Small labels such as "Deleted" and the
 * Add filter count use it too, so they read as the same kind of badge.
 */
export const CODE_BADGE_COLORS =
  "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100";

/**
 * Pads a table's first and last columns so text lines up with the table's
 * footer instead of touching its border. Pass it as the `Table` className.
 */
export const TABLE_EDGE_PADDING =
  "[&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4";

/**
 * Green and red status badges, such as Online and Offline, Applied and
 * Rejected, or a watcher event's success and error. Dark mode uses the 900
 * fills, which are about as light as the file pattern badge, with near-white
 * text.
 */
export const GREEN_BADGE_COLORS =
  "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100";
export const RED_BADGE_COLORS =
  "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100";

// Kept outside the client `sidebar.tsx` module so the server layout can read
// the cookie name without importing a Client Component file.
export const SIDEBAR_COOKIE_NAME = "sidebar_state";

// One cookie per collapsible group in the sidebar's navigation, written when
// the group is toggled and read by the layout so a closed group renders closed
// on first paint.
export const SIDEBAR_INSTRUMENTS_COOKIE_NAME = "sidebar_instruments_state";
export const SIDEBAR_NOTEBOOKS_COOKIE_NAME = "sidebar_notebooks_state";

/** Which of the navigation's collapsible groups are open. */
export interface SidebarNavGroupsOpen {
  instruments: boolean;
  notebooks: boolean;
}

// 400 days is the longest lifetime Chrome honors.
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

/**
 * Whether a sidebar cookie says open, for the sidebar itself or one of its
 * groups. A missing cookie, or any value but `"false"`, means open, so a first
 * visit shows everything expanded.
 */
export function isSidebarGroupOpen(cookieValue: string | undefined): boolean {
  return cookieValue !== "false";
}

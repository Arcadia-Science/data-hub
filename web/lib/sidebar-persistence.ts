// Kept outside the client `sidebar.tsx` module so the server layout can read
// the cookie name without importing a Client Component file.
export const SIDEBAR_COOKIE_NAME = "sidebar_state";

// 400 days is the longest lifetime Chrome honors.
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

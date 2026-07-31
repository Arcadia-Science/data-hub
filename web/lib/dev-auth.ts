// Shared constants for the non-production email/password sign-in path.
// Kept outside `lib/auth.ts` so seed scripts can import the password
// without pulling in Better Auth / Next.js server modules.
export const isDevAuthEnabled = process.env.NODE_ENV !== "production";
export const DEV_PASSWORD = "dev-password";

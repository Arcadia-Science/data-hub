// Bootstrap allowlist for the workspace admin role. Read from the
// `ADMIN_EMAILS` env var as a comma-separated list (whitespace tolerated).
// Emails listed here are auto-promoted to `is_admin = true` on every
// sign-in, which means:
//
//   - The first admin can be established without touching the DB.
//   - The list also works as a "permanent admins" floor — if the DB row is
//     ever demoted manually, the next sign-in re-promotes. This is
//     intentional; the `/settings/members` toggle is meant for ad-hoc
//     promotions of teammates not in the env, while the env list captures
//     the small set of operators who should always retain access.
//
// Comparison is case-insensitive and trimmed. Empty / unset env var means
// no env-bootstrapped admins; the only path to admin is then the members
// page (which itself requires an admin, so a totally-empty deployment has
// no admins until `ADMIN_EMAILS` is set and someone signs in).

let cached: Set<string> | null = null;

export function getAdminEmails(): Set<string> {
  if (cached) return cached;
  const raw = process.env.ADMIN_EMAILS ?? "";
  const set = new Set<string>();
  for (const entry of raw.split(",")) {
    const normalized = entry.trim().toLowerCase();
    if (normalized) set.add(normalized);
  }
  cached = set;
  return set;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().has(email.trim().toLowerCase());
}

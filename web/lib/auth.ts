import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { oAuthProxy } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { isAdminEmail } from "@/lib/admin-emails";
import { db } from "@/lib/db";
import { accounts, sessions, users, verifications } from "@/lib/db/schema";
import { isDevAuthEnabled } from "@/lib/dev-auth";

function originFromUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = value.startsWith("http")
      ? new URL(value)
      : new URL(`https://${value}`);
    return url.origin;
  } catch {
    return null;
  }
}

// Stable host that owns the Google redirect URI. Preview (and optionally
// local) deployments proxy Google SSO through this host via `oAuthProxy`.
// When it matches this deployment's `BETTER_AUTH_URL`, the plugin no-ops.
const oauthProxyUrl = process.env.OAUTH_PROXY_URL;
const oauthProxySecret = process.env.OAUTH_PROXY_SECRET;
const oauthProxyEnabled = Boolean(oauthProxyUrl && oauthProxySecret);

function resolveTrustedOrigins(): string[] {
  const origins = new Set<string>();
  const baseOrigin = originFromUrl(
    process.env.BETTER_AUTH_URL ?? process.env.VERCEL_URL
  );
  if (baseOrigin) {
    origins.add(baseOrigin);
  }
  if (process.env.VERCEL_URL) {
    origins.add(`https://${process.env.VERCEL_URL}`);
  }
  const proxyOrigin = originFromUrl(oauthProxyUrl);
  if (proxyOrigin) {
    origins.add(proxyOrigin);
  }
  // Staging receives the Google callback then redirects back to the
  // preview origin with an encrypted profile — that return hop must
  // pass CSRF origin checks. Vercel preview hosts are `*.vercel.app`.
  if (oauthProxyEnabled) {
    origins.add("https://*.vercel.app");
  }
  // Loopback only in non-production — never widen the CSRF allowlist in
  // deployed environments.
  if (isDevAuthEnabled) {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }
  return [...origins];
}

// One-way admin promotion from the `ADMIN_EMAILS` allowlist. Used by the
// session-create hook so existing users pick up a newly added allowlist
// entry without a schema write at sign-up time.
async function promoteAdminIfAllowlisted(userId: string): Promise<void> {
  const [row] = await db
    .select({ email: users.email, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row || row.isAdmin || !isAdminEmail(row.email)) {
    return;
  }

  await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
}

const googleClientId = process.env.AUTH_GOOGLE_ID;
const googleClientSecret = process.env.AUTH_GOOGLE_SECRET;

export const authInstance = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  ...(googleClientId && googleClientSecret
    ? {
        socialProviders: {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          },
        },
      }
    : {}),
  emailAndPassword: {
    enabled: isDevAuthEnabled,
    // Seeded users only — no open registration on the email path.
    disableSignUp: true,
    // Google SSO is the production gate; we never require a verified
    // inbox for the (dev-only) email/password path.
    requireEmailVerification: false,
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },
  user: {
    additionalFields: {
      isAdmin: {
        type: "boolean",
        required: true,
        defaultValue: false,
        // Server-owned; UI reads it, mutations re-check via `requireAdmin()`.
        input: false,
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  trustedOrigins: resolveTrustedOrigins(),
  // Prefer Vercel's single-value client IP header so rate-limit buckets
  // don't collapse when `x-forwarded-for` is a multi-hop chain.
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["x-vercel-forwarded-for", "x-forwarded-for"],
    },
  },
  rateLimit: {
    enabled: true,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-in/social": { window: 60, max: 10 },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({
          data: {
            ...user,
            isAdmin: isAdminEmail(user.email),
          },
        }),
      },
    },
    session: {
      create: {
        before: async (session) => {
          await promoteAdminIfAllowlisted(session.userId);
          return { data: session };
        },
      },
    },
  },
  plugins: [
    // Preview deployments can't register a Google redirect URI per URL.
    // When configured, OAuth starts on the preview, Google callbacks to
    // `OAUTH_PROXY_URL` (staging), and staging hands the profile back
    // encrypted — the preview writes the session in its own DB. No-ops
    // when this deployment's base URL equals `OAUTH_PROXY_URL`.
    ...(oauthProxyEnabled
      ? [
          oAuthProxy({
            productionURL: oauthProxyUrl,
            secret: oauthProxySecret,
          }),
        ]
      : []),
    // Must be last so Set-Cookie from server actions (sign-in / sign-out)
    // reaches the browser via Next's `cookies()` helper.
    nextCookies(),
  ],
});

export type Session = typeof authInstance.$Infer.Session;

// Drop-in replacement for Auth.js's `auth()`. Returns Better Auth's
// `{ user, session }` shape (or null); callers already only read
// `session?.user?.id` / `session.user.isAdmin`.
export const auth = cache(async () =>
  authInstance.api.getSession({ headers: await headers() })
);

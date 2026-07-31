import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { isAdminEmail } from "@/lib/admin-emails";
import { db } from "@/lib/db";
import { accounts, sessions, users, verifications } from "@/lib/db/schema";
import { isDevAuthEnabled } from "@/lib/dev-auth";

function resolveTrustedOrigins(): string[] {
  const origins = new Set<string>();
  const baseUrl = process.env.BETTER_AUTH_URL ?? process.env.VERCEL_URL;
  if (baseUrl) {
    try {
      const url = baseUrl.startsWith("http")
        ? new URL(baseUrl)
        : new URL(`https://${baseUrl}`);
      origins.add(url.origin);
    } catch {
      // Ignore malformed env values — Better Auth still trusts its own
      // `baseURL` origin when set via `BETTER_AUTH_URL`.
    }
  }
  if (process.env.VERCEL_URL) {
    origins.add(`https://${process.env.VERCEL_URL}`);
  }
  origins.add("http://localhost:3000");
  origins.add("http://127.0.0.1:3000");
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
  // Must be last so Set-Cookie from server actions (sign-in / sign-out)
  // reaches the browser via Next's `cookies()` helper.
  plugins: [nextCookies()],
});

export type Session = typeof authInstance.$Infer.Session;

// Drop-in replacement for Auth.js's `auth()`. Returns Better Auth's
// `{ user, session }` shape (or null); callers already only read
// `session?.user?.id` / `session.user.isAdmin`.
export const auth = cache(async () =>
  authInstance.api.getSession({ headers: await headers() })
);

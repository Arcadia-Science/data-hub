import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { cache } from "react";
import { isAdminEmail } from "@/lib/admin-emails";
import { db } from "@/lib/db";
import { accounts, sessions, users } from "@/lib/db/schema";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      // Workspace admin flag. Source of truth lives in `user.is_admin`;
      // this is the JWT-cached projection used for cheap UI affordance
      // gating (Edit dialog, Create token button, Members nav entry, etc).
      // Route handlers that authorize mutations re-read from the DB via
      // `requireAdmin()` so a demotion takes effect on the next request,
      // not the next sign-in.
      isAdmin: boolean;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id?: string;
    isAdmin?: boolean;
  }
}

// Resolve the canonical `is_admin` value for a user, applying the env
// allowlist as a one-way upgrade. Returns the value to expose on the JWT.
// Safe to call on every JWT issue — one indexed SELECT plus, at most, one
// UPDATE the first time an allowlisted user signs in (or after their row
// gets reset). Falls back to `false` if the user row has disappeared, so a
// stale JWT can never claim admin against a deleted account.
async function resolveIsAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ email: users.email, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    return false;
  }

  if (!row.isAdmin && isAdminEmail(row.email)) {
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    return true;
  }

  return row.isAdmin;
}

// Dev-only credentials provider: lets a local developer sign in as any
// user already present in the `user` table (typically seeded by
// `npm run db:seed`) by entering only their email — no Google OAuth, no
// password. Gated to non-production so a production build can never
// instantiate it; the `/login` page hides the affordance under the same
// guard. Combined with `session.strategy: "jwt"` below, the credentials
// provider mints a JWT directly (the DrizzleAdapter is bypassed for this
// provider — NextAuth's documented behavior for credentials + JWT).
const isDevAuthEnabled = process.env.NODE_ENV !== "production";

const providers = [
  Google,
  ...(isDevAuthEnabled
    ? [
        Credentials({
          id: "dev",
          name: "Dev account",
          credentials: {
            email: { label: "Email", type: "text" },
          },
          async authorize(credentials) {
            const email =
              typeof credentials?.email === "string"
                ? credentials.email.trim().toLowerCase()
                : null;
            if (!email) {
              return null;
            }
            const [row] = await db
              .select({
                id: users.id,
                name: users.name,
                email: users.email,
                image: users.image,
              })
              .from(users)
              .where(eq(users.email, email))
              .limit(1);
            return row ?? null;
          },
        }),
      ]
    : []),
];

const {
  handlers,
  signIn,
  signOut,
  auth: uncachedAuth,
} = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
  }),
  providers,
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user, trigger }) {
      // `user` is only present on the first JWT issue (immediately after
      // sign-in) and on session updates. Capture the id then so we have a
      // stable key for the admin lookup on subsequent token refreshes.
      if (user) {
        token.id = user.id;
      }
      // Re-resolve `isAdmin` from the DB on sign-in and on explicit
      // `session.update()` calls. Existing tokens keep their cached flag
      // for the lifetime of the JWT — route handlers do their own DB
      // check via `requireAdmin()` for any mutation, so a stale-true
      // flag in the UI never lets a non-admin actually mutate anything.
      //
      // `token.id` is cast because `JWT` extends `Record<string, unknown>`
      // in @auth/core — the module-augmentation `id?: string` narrows the
      // property but the index signature still widens it to `unknown` at
      // the call site.
      const id = token.id as string | undefined;
      if (id && (trigger === "signIn" || trigger === "update")) {
        token.isAdmin = await resolveIsAdmin(id);
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      session.user.isAdmin = token.isAdmin === true;
      return session;
    },
  },
});

export { handlers, isDevAuthEnabled, signIn, signOut };

export const auth = cache(uncachedAuth);

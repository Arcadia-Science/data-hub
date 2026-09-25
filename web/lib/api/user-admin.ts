import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Reads `users.is_admin` on every call so a demotion takes effect immediately,
// rather than trusting a cached session or token claim.
export async function userIsAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.isAdmin === true;
}

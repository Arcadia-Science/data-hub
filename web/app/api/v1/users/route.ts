import { asc } from "drizzle-orm";
import { requireAdmin } from "@/lib/api/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Admin-only roster used by `/settings/members`. Returns every signed-in
// user along with their workspace admin flag so the members page can
// render the toggle. We intentionally do not paginate — the Data Hub
// workspace is small enough (single-digit-to-low-tens of teammates) that
// a single round-trip is faster than building list UI on top of cursor
// state.
export async function GET() {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      is_admin: users.isAdmin,
    })
    .from(users)
    .orderBy(asc(users.email));

  return Response.json(rows);
}

// Connects the feedback package to Data Hub's login, users, and notifications.
// Everything else the package needs, such as the routes and pages, imports
// `feedback` from here.

import { createAppFeedback } from "@arcadiascience/app-feedback-toolkit/server";
import { eq, inArray, sql } from "drizzle-orm";
import { requireSession } from "@/lib/api/auth";
import {
  notifyFeedbackSubmitted,
  notifyFeedbackUpdated,
} from "@/lib/api/notifications";
import { appOrigin } from "@/lib/app-origin";
import { db } from "@/lib/db";
import { oauthClients, users } from "@/lib/db/schema";
import { FEEDBACK_APP } from "@/lib/feedback-app";

const userColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  image: users.image,
};

// Reads `users.is_admin` every time, so a demotion takes effect on the next
// request instead of waiting for a cached session to expire.
async function viewerById(userId: string) {
  const [row] = await db
    .select({ ...userColumns, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row
    ? {
        id: row.id,
        name: row.name,
        email: row.email,
        isAdmin: row.isAdmin === true,
      }
    : null;
}

export const feedback = createAppFeedback({
  ...FEEDBACK_APP,
  db,
  origin: appOrigin,
  secretsKey: () => process.env.INTEGRATION_SECRETS_KEY,

  // A report belongs to the person who wrote it, so a personal access token
  // never counts as a viewer. `requireSession` only accepts a browser session.
  async getViewer() {
    const session = await requireSession();
    return session ? viewerById(session.userId) : null;
  },
  getMcpViewer(authInfo) {
    const userId = authInfo?.extra?.userId;
    return typeof userId === "string"
      ? viewerById(userId)
      : Promise.resolve(null);
  },

  getUsersByIds: (ids) =>
    db.select(userColumns).from(users).where(inArray(users.id, ids)),
  findUsersByEmails: (emails) =>
    db
      .select(userColumns)
      .from(users)
      .where(inArray(sql`lower(${users.email})`, emails)),
  async getOauthClientNames(clientIds) {
    const rows = await db
      .select({ clientId: oauthClients.clientId, name: oauthClients.name })
      .from(oauthClients)
      .where(inArray(oauthClients.clientId, clientIds));
    return Object.fromEntries(rows.map((row) => [row.clientId, row.name]));
  },

  onReportSubmitted: (report) => notifyFeedbackSubmitted(report),
  onReportClosed: (report) => notifyFeedbackUpdated(report),
});

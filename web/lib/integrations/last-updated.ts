// "Last updated by" for the singleton integration settings rows. Each config
// module joins `users` on its `updatedBy` column and selects these columns.

import { users } from "@/lib/db/schema";

export interface LastUpdated {
  at: string;
  byEmail: string | null;
  byId: string | null;
  byName: string | null;
}

export const lastUpdatedByColumns = {
  updatedById: users.id,
  updatedByName: users.name,
  updatedByEmail: users.email,
};

interface LastUpdatedRow {
  updatedAt: Date | null;
  updatedByEmail: string | null;
  updatedById: string | null;
  updatedByName: string | null;
}

export function toLastUpdated(
  row: LastUpdatedRow | null | undefined
): LastUpdated | null {
  if (!row?.updatedAt) {
    return null;
  }
  return {
    at: row.updatedAt.toISOString(),
    byId: row.updatedById,
    byName: row.updatedByName,
    byEmail: row.updatedByEmail,
  };
}

export function lastUpdatedResponse(lastUpdated: LastUpdated | null) {
  return {
    updated_at: lastUpdated?.at ?? null,
    updated_by: lastUpdated?.byId
      ? {
          id: lastUpdated.byId,
          name: lastUpdated.byName,
          email: lastUpdated.byEmail,
        }
      : null,
  };
}

// Every watcher registration of an instrument, for its watcher page: the
// current one and the past (deregistered) ones. `getInstrumentWatcherInfo`
// reads the current watcher of many instruments in a few queries; this read is
// for the one instrument whose page is open, and also says when each
// registration began and ended and who deregistered it.

import { desc, eq } from "drizzle-orm";
import { cache } from "react";
import { actorDisplayName, resolveActor } from "@/lib/api/actor";
import { db } from "@/lib/db";
import { personalAccessTokens, users, watchers } from "@/lib/db/schema";
import type { WatcherRegistration } from "@/lib/watchers/registrations";

/**
 * All of an instrument's watcher rows, newest first, deregistered ones
 * included. `cache()` shares one read within a request.
 */
export const listWatcherRegistrations = cache(
  async function listWatcherRegistrations(
    instrumentId: string
  ): Promise<WatcherRegistration[]> {
    const rows = await db
      .select({
        id: watchers.id,
        hostname: watchers.hostname,
        createdAt: watchers.createdAt,
        deletedAt: watchers.deletedAt,
        deregisteredByUserId: watchers.deregisteredBy,
        deregisteredByTokenId: watchers.deregisteredByToken,
        deregisteredByName: users.name,
        deregisteredByEmail: users.email,
        deregisteredByImage: users.image,
        deregisteredByTokenName: personalAccessTokens.name,
        deregisteredByTokenRevokedAt: personalAccessTokens.revokedAt,
      })
      .from(watchers)
      // The person or token that deregistered it. All NULL for the current
      // registration, and for one deregistered before the column existed.
      .leftJoin(users, eq(users.id, watchers.deregisteredBy))
      .leftJoin(
        personalAccessTokens,
        eq(personalAccessTokens.id, watchers.deregisteredByToken)
      )
      .where(eq(watchers.instrumentId, instrumentId))
      .orderBy(desc(watchers.createdAt));

    return rows.map((row) => {
      const actor = resolveActor({
        userId: row.deregisteredByUserId,
        userName: row.deregisteredByName,
        userEmail: row.deregisteredByEmail,
        userImage: row.deregisteredByImage,
        tokenId: row.deregisteredByTokenId,
        tokenName: row.deregisteredByTokenName,
        tokenRevokedAt: row.deregisteredByTokenRevokedAt,
      });
      return {
        id: row.id,
        hostname: row.hostname,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
        deregisteredByName: actor ? actorDisplayName(actor) : null,
      };
    });
  }
);

// The Confirm review's data for one instrument: the registration and settings of
// its active watcher, and a worked example from a recent file. The route that
// serves it and the instrument page both check that the viewer is an admin.

import { and, eq, isNull } from "drizzle-orm";
import { resolveActor } from "@/lib/api/actor";
import { readInstrumentConfigFields } from "@/lib/api/watcher-config/from-yaml";
import { runIdForPathGuarded } from "@/lib/api/watcher-config/guarded-run-id";
import { latestRawFilePaths } from "@/lib/api/watcher-config/revisions";
import { type DbExecutor, db } from "@/lib/db";
import { instruments, personalAccessTokens, watchers } from "@/lib/db/schema";
import {
  type InstrumentConfirmReview,
  workedRunExample,
} from "@/lib/instruments/confirm-review";

/** The review for one instrument, or null when no instrument has that ID. */
export async function getInstrumentConfirmReview(
  instrumentId: string,
  executor: DbExecutor = db
): Promise<InstrumentConfirmReview | null> {
  const [instrument] = await executor
    .select({ displayName: instruments.displayName })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);
  if (!instrument) {
    return null;
  }

  const [active] = await executor
    .select({
      hostname: watchers.hostname,
      configYaml: watchers.configYaml,
      tokenId: personalAccessTokens.id,
      tokenName: personalAccessTokens.name,
      tokenRevokedAt: personalAccessTokens.revokedAt,
    })
    .from(watchers)
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, watchers.registeredByToken)
    )
    .where(
      and(eq(watchers.instrumentId, instrumentId), isNull(watchers.deletedAt))
    )
    .limit(1);
  if (!active) {
    return {
      displayName: instrument.displayName,
      instrumentId,
      runExample: null,
      watcher: null,
    };
  }

  const config = readInstrumentConfigFields(active.configYaml);
  // The registering token keeps its name once revoked, as elsewhere in the app.
  const registeredBy = resolveActor({
    userId: null,
    userName: null,
    userEmail: null,
    userImage: null,
    tokenId: active.tokenId,
    tokenName: active.tokenName,
    tokenRevokedAt: active.tokenRevokedAt,
  });

  // The newest raw file's path, relative to the watch folder like the watcher
  // matches it. The pattern comes from the watcher's config and this runs while
  // the page renders, so it goes through the guarded matcher.
  let runExample: InstrumentConfirmReview["runExample"] = null;
  if (config.runDetection) {
    const [recentPath = null] = await latestRawFilePaths(
      instrumentId,
      1,
      executor
    );
    runExample = workedRunExample(
      config.runDetection.pattern,
      recentPath?.replaceAll("\\", "/") ?? null,
      runIdForPathGuarded
    );
  }

  return {
    displayName: instrument.displayName,
    instrumentId,
    runExample,
    watcher: {
      hostname: active.hostname,
      tokenName:
        registeredBy?.kind === "token" ? registeredBy.token.name : null,
      tokenRevoked:
        registeredBy?.kind === "token" && registeredBy.token.revoked,
      filePatterns: config.filePatterns,
      runDetection: config.runDetection,
      uploadMode: config.uploadMode,
      watchDirectory: config.watchDirectory,
    },
  };
}

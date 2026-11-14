// The Confirm review's data for one instrument: the registration and settings of
// its active watcher, and a recent file for the worked example. The route that
// serves it and the instrument page both check that the viewer is an admin.

import { and, desc, eq, isNull } from "drizzle-orm";
import { readInstrumentConfigFields } from "@/lib/api/watcher-config/from-yaml";
import { type DbExecutor, db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  personalAccessTokens,
  watchers,
} from "@/lib/db/schema";
import type { InstrumentConfirmReview } from "@/lib/instruments/confirm-review";

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

  // The newest file of any run. Its path is relative to the watch folder, which
  // is what run detection matches; the bare file name is the fallback.
  const [recent] = await executor
    .select({ filename: files.filename, relativePath: files.relativePath })
    .from(files)
    .innerJoin(instrumentRuns, eq(instrumentRuns.id, files.instrumentRunId))
    .where(
      and(
        eq(instrumentRuns.instrumentId, instrumentId),
        isNull(instrumentRuns.deletedAt)
      )
    )
    .orderBy(desc(files.detectedAt))
    .limit(1);

  let watcher: InstrumentConfirmReview["watcher"] = null;
  if (active) {
    const config = readInstrumentConfigFields(active.configYaml);
    watcher = {
      hostname: active.hostname,
      // A revoked token no longer names the registration.
      tokenName: active.tokenRevokedAt ? null : active.tokenName,
      filePatterns: config.filePatterns,
      runDetection: config.runDetection,
      uploadMode: config.uploadMode,
      watchDirectory: config.watchDirectory,
    };
  }

  return {
    displayName: instrument.displayName,
    instrumentId,
    recentFilePath: recent ? recent.relativePath || recent.filename : null,
    watcher,
  };
}

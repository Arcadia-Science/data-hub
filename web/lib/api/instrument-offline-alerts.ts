// The offline-alert job: tells an instrument's subscribers when its badge has
// been Offline for 30 minutes, and again when it's Online. Vercel Cron runs it
// every 5 minutes through `/api/cron/instrument-offline-alerts`.
//
// The badge is derived on every read, so the job keeps its own memory of each
// outage in `instrument_offline_alerts`, and `stepOfflineAlert` decides how
// each run moves it. Every change is one guarded statement on the job's own
// clock, so two runs at once (Vercel can start a cron job twice) agree: the
// second run's claim finds nothing to claim and sends nothing.

import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import {
  type InstrumentConnectionSnapshot,
  listInstrumentConnections,
} from "@/lib/api/instrument-watchers";
import { notifyInstrumentConnection } from "@/lib/api/notifications";
import { appOrigin } from "@/lib/app-origin";
import { db } from "@/lib/db";
import { instrumentOfflineAlerts } from "@/lib/db/schema";
import {
  backOnlineMessage,
  CRON_JITTER_MS,
  isOfflineAlertPaused,
  OFFLINE_ALERT_AFTER_MS,
  type OfflineAlertState,
  offlineAlertMessage,
  stepOfflineAlert,
} from "@/lib/instruments/offline-alerts";
import { deliverSlackDms, type SlackDmJob } from "@/lib/slack/dm";

export interface OfflineAlertRunSummary {
  alerted: number;
  cleared: number;
  failed_instruments: number;
  paused: boolean;
  recovered: number;
  started: number;
}

export async function runInstrumentOfflineAlerts(
  options: { now?: Date; origin?: string } = {}
): Promise<OfflineAlertRunSummary> {
  const now = options.now ?? new Date();
  const origin = options.origin ?? appOrigin();

  const [snapshot, alertRows] = await Promise.all([
    listInstrumentConnections(now),
    db.select().from(instrumentOfflineAlerts),
  ]);
  const stateByInstrument = new Map<string, OfflineAlertState>(
    alertRows.map((row) => [
      row.instrumentId,
      { offlineSince: row.offlineSince, alertedAt: row.alertedAt },
    ])
  );

  const paused = isOfflineAlertPaused(snapshot.watchers, now);
  if (paused) {
    console.warn(
      "[instrument-offline-alerts] Several watchers went quiet together and none has checked in for 5 minutes, so unresponsive alerts are paused this run."
    );
  }

  const summary: OfflineAlertRunSummary = {
    paused,
    started: 0,
    alerted: 0,
    recovered: 0,
    cleared: 0,
    failed_instruments: 0,
  };

  for (const instrument of snapshot.instruments) {
    // One instrument's failure must not stop the rest. The next run retries.
    try {
      const state = stateByInstrument.get(instrument.instrumentId) ?? null;
      const transition = stepOfflineAlert(
        state,
        {
          badge: instrument.badge,
          reason: instrument.connection.reason,
        },
        now,
        paused
      );
      switch (transition) {
        case "none":
          break;
        case "start":
          await startClock(instrument.instrumentId, now);
          summary.started += 1;
          break;
        case "clear":
          await clearClock(instrument.instrumentId, state);
          summary.cleared += 1;
          break;
        case "alert":
          if (await sendOfflineAlert(instrument, now, origin)) {
            summary.alerted += 1;
          }
          break;
        case "recover":
          if (await sendBackOnline(instrument, now, origin)) {
            summary.recovered += 1;
          }
          break;
        default:
          throw new Error(
            `Unknown transition: ${transition satisfies never as string}`
          );
      }
    } catch (err) {
      summary.failed_instruments += 1;
      console.error(
        `[instrument-offline-alerts] failed for instrument ${instrument.instrumentId}: ${err}`
      );
    }
  }

  return summary;
}

async function startClock(instrumentId: string, now: Date): Promise<void> {
  await db
    .insert(instrumentOfflineAlerts)
    .values({ instrumentId, offlineSince: now })
    .onConflictDoNothing();
}

// Deletes the row only if it is still in the state this run saw, so a clear
// decided on a Waiting row can't wipe an alert another run just sent.
async function clearClock(
  instrumentId: string,
  state: OfflineAlertState | null
): Promise<void> {
  await db
    .delete(instrumentOfflineAlerts)
    .where(
      and(
        eq(instrumentOfflineAlerts.instrumentId, instrumentId),
        state?.alertedAt
          ? isNotNull(instrumentOfflineAlerts.alertedAt)
          : isNull(instrumentOfflineAlerts.alertedAt)
      )
    );
}

async function sendOfflineAlert(
  instrument: InstrumentConnectionSnapshot,
  now: Date,
  origin: string
): Promise<boolean> {
  const reason = instrument.connection.reason;
  if (reason === null) {
    return false;
  }
  const message = offlineAlertMessage(reason, {
    hostname: instrument.watcher?.hostname ?? null,
    lastHeartbeatAt: instrument.watcher?.lastHeartbeatAt ?? null,
    watchDirectory: instrument.watcher?.watchDirectory ?? null,
    now,
  });
  const cutoff = new Date(
    now.getTime() - (OFFLINE_ALERT_AFTER_MS - CRON_JITTER_MS)
  );

  const slackJobs = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(instrumentOfflineAlerts)
      .set({ alertedAt: now })
      .where(
        and(
          eq(instrumentOfflineAlerts.instrumentId, instrument.instrumentId),
          isNull(instrumentOfflineAlerts.alertedAt),
          lte(instrumentOfflineAlerts.offlineSince, cutoff)
        )
      )
      .returning({ instrumentId: instrumentOfflineAlerts.instrumentId });
    if (claimed.length === 0) {
      return null;
    }
    return notifyInstrumentConnection(tx, {
      kind: "instrument_offline",
      instrumentId: instrument.instrumentId,
      instrumentDisplayName: instrument.displayName,
      message,
      origin,
    });
  });
  return deliverAfterCommit(slackJobs);
}

async function sendBackOnline(
  instrument: InstrumentConnectionSnapshot,
  now: Date,
  origin: string
): Promise<boolean> {
  const slackJobs = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .delete(instrumentOfflineAlerts)
      .where(
        and(
          eq(instrumentOfflineAlerts.instrumentId, instrument.instrumentId),
          isNotNull(instrumentOfflineAlerts.alertedAt)
        )
      )
      .returning({ offlineSince: instrumentOfflineAlerts.offlineSince });
    if (!claimed) {
      return null;
    }
    return notifyInstrumentConnection(tx, {
      kind: "instrument_back_online",
      instrumentId: instrument.instrumentId,
      instrumentDisplayName: instrument.displayName,
      message: backOnlineMessage(claimed.offlineSince, now),
      origin,
    });
  });
  return deliverAfterCommit(slackJobs);
}

// Null when another run claimed the change first. Slack failures are logged
// inside `deliverSlackDms` and never undo the in-app rows.
async function deliverAfterCommit(
  slackJobs: SlackDmJob[] | null
): Promise<boolean> {
  if (slackJobs === null) {
    return false;
  }
  await deliverSlackDms(slackJobs);
  return true;
}

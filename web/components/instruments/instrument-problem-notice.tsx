import { ArrowRight, FolderOpen, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { buttonVariants } from "@/components/ui/button";
import { SetupGuideLink } from "@/components/watchers/setup-guide-link";
import {
  NOTICE_LINK_CLASSNAME,
  WatcherNotice,
} from "@/components/watchers/watcher-notice";
import { getInstrumentById } from "@/lib/api/instruments";
import { listWatcherRegistrations } from "@/lib/api/watcher-registrations";
import {
  instrumentProblemNotice,
  type ProblemNotice,
  type ProblemNoticeAction,
  type ProblemNoticeBodyPart,
} from "@/lib/instruments/problem-notice";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import { watcherPageHref } from "@/lib/watchers/routes";

const BUTTON_CLASSNAME = buttonVariants({ variant: "outline", size: "sm" });

function NoticeBody({ parts }: { parts: ProblemNoticeBodyPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <Fragment key={index}>{part}</Fragment>
        ) : (
          <span className="break-all font-mono text-xs" key={index}>
            {part.code}
          </span>
        )
      )}
    </>
  );
}

function NoticeAction({
  action,
  instrumentId,
}: {
  action: ProblemNoticeAction;
  instrumentId: string;
}) {
  switch (action) {
    case "change_folder":
      return (
        <Link
          className={BUTTON_CLASSNAME}
          href={watcherPageHref(instrumentId, {
            tab: "settings",
            focus: "watch_directory",
          })}
        >
          <FolderOpen aria-hidden="true" />
          Change folder
        </Link>
      );
    case "connect_watcher":
      return (
        <SetupGuideLink className={BUTTON_CLASSNAME}>
          Connect a watcher
        </SetupGuideLink>
      );
    case "see_details":
      return (
        <Link
          className={NOTICE_LINK_CLASSNAME}
          href={watcherPageHref(instrumentId)}
        >
          See details
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      );
    default:
      return action satisfies never;
  }
}

/**
 * Says why new files can't arrive, between the instrument's header and its
 * runs. The title and sentence come from `instrumentProblemNotice`, which also
 * decides what each viewer can do about it.
 */
export function InstrumentProblemNotice({
  instrumentId,
  notice,
}: {
  instrumentId: string;
  notice: ProblemNotice;
}) {
  return (
    <WatcherNotice
      actions={
        notice.actions.length > 0
          ? notice.actions.map((action) => (
              <NoticeAction
                action={action}
                instrumentId={instrumentId}
                key={action}
              />
            ))
          : null
      }
      icon={TriangleAlert}
      title={notice.title}
      tone="danger"
    >
      <NoticeBody parts={notice.body} />
    </WatcherNotice>
  );
}

/**
 * Loads what the notice needs and renders it, or nothing. The header and this
 * stream separately, so the notice's extra read (who deregistered the watcher)
 * never holds the header up. `getInstrumentById` is `cache()`-deduped, so
 * this adds no second read of the instrument.
 */
export async function InstrumentProblemNoticeSection({
  instrumentId,
  isAdmin,
}: {
  instrumentId: string;
  isAdmin: boolean;
}) {
  const instrument = await getInstrumentById(instrumentId);
  if (!instrument) {
    // The header's section answers with a 404.
    return null;
  }

  // Only a deregistered instrument needs the watchers it had: the newest
  // registration is the one that ended.
  const wasDeregistered = instrument.connection.reason === "deregistered";
  const [timeZone, registrations] = await Promise.all([
    getViewerTimeZone(),
    wasDeregistered ? listWatcherRegistrations(instrumentId) : [],
  ]);
  const past = registrations.find((r) => r.deletedAt !== null) ?? null;

  const notice = instrumentProblemNotice({
    status: instrument.status,
    connection: instrument.connection,
    isAdmin,
    timeZone,
    watcher: instrument.watcher,
    deregistration: past
      ? { at: past.deletedAt, byName: past.deregisteredByName }
      : null,
  });
  if (!notice) {
    return null;
  }
  return (
    <InstrumentProblemNotice instrumentId={instrument.id} notice={notice} />
  );
}

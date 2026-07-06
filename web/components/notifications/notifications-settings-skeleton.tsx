import { SlackChannelCard } from "@/components/notifications/slack-channel-card";
import { SlackConnectionCard } from "@/components/notifications/slack-connection-card";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function NotificationFieldSkeleton({
  twoLineDescription = false,
  labelWidth = "w-56",
}: {
  twoLineDescription?: boolean;
  labelWidth?: string;
}) {
  return (
    <div className="flex w-full flex-row items-start gap-3">
      <div className="flex min-w-0 flex-auto flex-col gap-1.5">
        <Skeleton className={`h-4 ${labelWidth}`} />
        {twoLineDescription ? (
          <>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </>
        ) : (
          <Skeleton className="h-4 w-80" />
        )}
      </div>
      <Skeleton className="h-5 w-8 shrink-0 rounded-full" />
    </div>
  );
}

function InstrumentNotificationFieldSkeleton() {
  return (
    <div className="flex w-full flex-row items-center gap-3">
      <Skeleton className="h-4 w-52" />
      <Skeleton className="ml-auto h-5 w-8 shrink-0 rounded-full" />
    </div>
  );
}

function NotificationsInAppCardSkeleton({
  instrumentRows = 8,
}: {
  instrumentRows?: number;
}) {
  return (
    <Card>
      <CardContent>
        <div className="flex flex-col gap-7">
          <NotificationFieldSkeleton twoLineDescription />
          <div className="border-t" />
          <NotificationFieldSkeleton labelWidth="w-48" />
          <NotificationFieldSkeleton labelWidth="w-40" />
        </div>
      </CardContent>
      <div className="border-t" />
      <CardContent>
        <div className="mb-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-1 h-4 w-full max-w-lg" />
        </div>
        <div className="flex flex-col gap-7">
          {Array.from({ length: instrumentRows }).map((_, i) => (
            <InstrumentNotificationFieldSkeleton key={i} />
          ))}
        </div>
      </CardContent>
      <CardFooter className="border-t">
        <div className="flex w-full items-center justify-end">
          <Skeleton className="h-9 w-16" />
        </div>
      </CardFooter>
    </Card>
  );
}

function SlackConnectionSectionSkeleton() {
  return (
    <>
      <SlackConnectionCard.SectionHeader
        connected={false}
        revoked={false}
        slackTeamName={null}
      />
      <Card>
        <CardContent>
          <Skeleton className="h-9 w-36" />
        </CardContent>
      </Card>
    </>
  );
}

function SlackChannelSectionSkeleton() {
  return (
    <>
      <SlackChannelCard.SectionHeader configured={false} />
      <Card>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-9 w-16" />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/** Mirrors `NotificationsSettingsForm` layout so streamed settings swap in cleanly. */
export function NotificationsSettingsFormSkeleton({
  instrumentRows = 8,
  isAdmin = false,
}: {
  instrumentRows?: number;
  isAdmin?: boolean;
}) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading notification settings"
      className="flex flex-col gap-6"
      role="status"
    >
      <NotificationsInAppCardSkeleton instrumentRows={instrumentRows} />
      <SlackConnectionSectionSkeleton />
      {isAdmin ? <SlackChannelSectionSkeleton /> : null}
    </div>
  );
}

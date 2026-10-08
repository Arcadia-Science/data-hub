import { FeedbackReviewPage } from "@arcadiascience/app-feedback-toolkit/next";
import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { auth } from "@/lib/auth";
import { feedback } from "@/lib/feedback";

const description = "Review bugs and requests sent about Data Hub.";

export const metadata: Metadata = {
  title: "Feedback",
  description,
  openGraph: { title: "Feedback", description },
  twitter: { title: "Feedback", description },
};

export default async function FeedbackSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings/feedback">
        Sign in to review feedback.
      </SignInRequired>
    );
  }

  if (!session.user.isAdmin) {
    return <AdminsOnly>review feedback</AdminsOnly>;
  }

  // Full width because the table needs more room than the default column.
  return (
    <SettingsPageContent className="w-full">
      <FeedbackReviewPage
        feedback={feedback}
        integrationsHref="/settings/integrations"
        reviewPath="/settings/feedback"
        searchParams={await searchParams}
        viewerId={session.user.id}
      />
    </SettingsPageContent>
  );
}

import type { Metadata } from "next";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { auth } from "@/lib/auth";

export const metadata: Metadata = {
  title: {
    template: "%s | Settings | Data Hub",
    default: "Settings | Data Hub",
  },
};

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  // Belt-and-braces auth gate. Each settings page is also expected to
  // render its own `SignInRequired` when there's no session — that's what
  // actually short-circuits any DB / I/O work, since a layout can decide
  // *whether* to render its children but cannot prevent the children from
  // having already executed their async body.
  //
  // Returning `SignInRequired` here (instead of `{children}`) keeps
  // page-level `metadata` exports merging into the head — Next resolves
  // metadata independently of whether the layout actually renders its
  // children — so unfurlers still see "Settings | Data Hub" / "Access
  // tokens" titles.
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings">
        Sign in to manage settings.
      </SignInRequired>
    );
  }

  // No layout-level "Settings" title: the SettingsNav sidebar already
  // labels this section, so a title here was duplicative chrome on every
  // settings page. Each page renders its own H1 instead, so screen readers
  // still get one page title; section headings inside a page are H2.
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-4 pb-10 sm:px-6 lg:px-8 2xl:w-6xl">
      {children}
    </div>
  );
}

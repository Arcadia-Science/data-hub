import { SignInRequired } from "@/components/auth/sign-in-required";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";

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
  // Tokens" titles.
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings">
        Sign in to manage settings.
      </SignInRequired>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8 2xl:w-7xl">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}

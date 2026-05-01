import { auth } from "@/lib/auth";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

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
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8 2xl:w-7xl">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}

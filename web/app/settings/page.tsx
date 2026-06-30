import { redirect } from "next/navigation";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { auth } from "@/lib/auth";

export default async function SettingsPage() {
  // Self-defending auth gate; mirrors `tokens/page.tsx`. Without this an
  // unauth visit would `redirect()` to `/settings/notifications` before the
  // layout's auth check ever runs (page renders before layout), wasting a
  // 307 round-trip. With it, unauth visitors land on the sign-in CTA
  // directly and come back to `/settings/notifications` after sign-in.
  const session = await auth();
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings/notifications">
        Sign in to manage settings.
      </SignInRequired>
    );
  }
  redirect("/settings/notifications");
}

import type { Metadata } from "next/types";
import { AuthScreen } from "@/components/auth/auth-screen";
import { safeCallbackPath } from "@/lib/callback-url";

export const metadata: Metadata = {
  title: "Sign in",
};

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  // MCP OAuth sign-ins resume through the signed `client_id` query, so a
  // return address must not compete with it.
  const callbackUrl = params.client_id
    ? "/"
    : safeCallbackPath(params.callbackURL);

  return (
    <AuthScreen
      callbackUrl={callbackUrl}
      devInputId="login-dev-email"
      fromLoginPage
      heading="Welcome to Data Hub"
    >
      Lab instrument data, captured and processed automatically — explore your
      runs from the web, API, or an AI agent.
    </AuthScreen>
  );
}

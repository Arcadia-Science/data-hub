import type { Metadata } from "next/types";
import { AuthScreen } from "@/components/auth/auth-screen";
import { loginPageCallbackPath } from "@/lib/callback-url";

export const metadata: Metadata = {
  title: "Sign in",
};

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  return (
    <AuthScreen
      callbackUrl={loginPageCallbackPath(await searchParams)}
      devInputId="login-dev-email"
      fromLoginPage
      heading="Welcome to Data Hub"
    >
      Lab instrument data, captured and processed automatically — explore your
      runs from the web, API, or an AI agent.
    </AuthScreen>
  );
}

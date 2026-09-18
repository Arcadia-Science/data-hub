import type { Metadata } from "next/types";
import { AuthScreen } from "@/components/auth/auth-screen";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <AuthScreen
      callbackUrl="/"
      devInputId="login-dev-email"
      heading="Welcome to Data Hub"
    >
      Lab instrument data, captured and processed automatically — explore your
      runs from the web, API, or an AI agent.
    </AuthScreen>
  );
}

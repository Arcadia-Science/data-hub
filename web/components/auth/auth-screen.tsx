import { CloudUpload, FlaskConical, Lock, Terminal } from "lucide-react";
import { headers } from "next/headers";
import Image from "next/image";
import { redirect, unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { AuthErrorBanner } from "@/components/auth/auth-error-banner";
import { redirectWithAuthError } from "@/components/auth/auth-sign-in-error";
import { DevSignInForm } from "@/components/auth/dev-sign-in-form";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { authInstance } from "@/lib/auth";
import { isDevAuthEnabled } from "@/lib/dev-auth";
import { DOCS_URL, QUICKSTART_DOCS_URL } from "@/lib/docs";

interface AuthScreenProps {
  callbackUrl: string;
  children?: React.ReactNode;
  devInputId: string;
  heading: string;
}

const FEATURES = [
  {
    icon: CloudUpload,
    title: "Automatic uploads",
    description: "A watcher captures every run",
  },
  {
    icon: FlaskConical,
    title: "Processed instantly",
    description: "Files ingested as they appear",
  },
  {
    icon: Terminal,
    title: "Web, API, or AI agent",
    description: "Analyze runs any way you work",
  },
] as const;

export function AuthScreen({
  callbackUrl,
  heading,
  devInputId,
  children,
}: AuthScreenProps) {
  async function signInWithGoogle() {
    "use server";
    try {
      const result = await authInstance.api.signInSocial({
        body: {
          provider: "google",
          callbackURL: callbackUrl,
        },
        headers: await headers(),
      });
      if (result.url) {
        redirect(result.url);
      }
    } catch (error) {
      unstable_rethrow(error);
    }
    redirectWithAuthError(callbackUrl, "google");
  }

  return (
    <div className="grid min-h-[calc(100svh_-_var(--banner-height,0px))] w-full lg:grid-cols-2">
      <div className="flex flex-col bg-background">
        <div className="flex flex-1 flex-col justify-center px-8 py-12 sm:px-12 lg:px-16">
          <div className="mx-auto w-full max-w-md">
            <Image
              alt="Data Hub"
              className="size-12"
              height={48}
              priority
              src="/images/data-hub-logo.svg"
              width={48}
            />

            <h1 className="mt-6 font-semibold text-3xl tracking-tight">
              {heading}
            </h1>
            {children ? (
              <p className="mt-3 text-muted-foreground leading-relaxed">
                {children}
              </p>
            ) : null}

            <div className="mt-8 w-full">
              <Suspense
                fallback={
                  <div className="h-11 w-full animate-pulse rounded-md bg-muted" />
                }
              >
                <GoogleSignInButton signInAction={signInWithGoogle} />
              </Suspense>
            </div>

            <Suspense fallback={null}>
              <AuthErrorBanner />
            </Suspense>

            <p className="mt-4 flex items-center gap-2 text-muted-foreground text-sm">
              <Lock aria-hidden className="size-3.5 shrink-0" />
              Sign in with your Google Workspace account
            </p>

            {isDevAuthEnabled ? (
              <div className="mt-8">
                <DevSignInForm callbackUrl={callbackUrl} inputId={devInputId} />
              </div>
            ) : null}
          </div>
        </div>

        <footer className="px-8 pb-8 sm:px-12 lg:px-16">
          <div className="mx-auto flex w-full max-w-md gap-6 text-muted-foreground text-sm">
            <a
              className="transition-colors hover:text-foreground"
              href={QUICKSTART_DOCS_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Quickstart
            </a>
            <a
              className="transition-colors hover:text-foreground"
              href={DOCS_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Docs
            </a>
          </div>
        </footer>
      </div>

      <div className="hidden flex-col justify-center bg-blue-50 px-12 py-16 lg:flex dark:bg-blue-950/30">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
          {FEATURES.map((feature) => (
            <div
              className="flex items-start gap-4 rounded-xl border border-blue-100/80 bg-background p-5 shadow-sm dark:border-blue-900/50"
              key={feature.title}
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                <feature.icon aria-hidden className="size-5" />
              </div>
              <div>
                <p className="font-medium">{feature.title}</p>
                <p className="mt-0.5 text-muted-foreground text-sm">
                  {feature.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

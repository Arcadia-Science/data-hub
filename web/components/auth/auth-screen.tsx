import { CloudUpload, FlaskConical, Lock, Terminal } from "lucide-react";
import Image from "next/image";
import { redirect } from "next/navigation";
import { DevSignInForm } from "@/components/auth/dev-sign-in-form";
import { Button } from "@/components/ui/button";
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

function GoogleIcon() {
  return (
    <svg
      aria-hidden
      className="size-5"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Google</title>
      <path
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        fill="#EA4335"
      />
      <path
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        fill="#4285F4"
      />
      <path
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        fill="#FBBC05"
      />
      <path
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        fill="#34A853"
      />
    </svg>
  );
}

export function AuthScreen({
  callbackUrl,
  heading,
  devInputId,
  children,
}: AuthScreenProps) {
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

            <form
              action={async () => {
                "use server";
                const result = await authInstance.api.signInSocial({
                  body: {
                    provider: "google",
                    callbackURL: callbackUrl,
                  },
                });
                if (result.url) {
                  redirect(result.url);
                }
              }}
              className="mt-8 w-full"
            >
              <Button
                className="h-11 w-full cursor-pointer gap-3 bg-background text-base shadow-xs"
                size="lg"
                type="submit"
                variant="outline"
              >
                <GoogleIcon />
                Sign in with Google
              </Button>
            </form>

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

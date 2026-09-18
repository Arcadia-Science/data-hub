"use client";

import { Loader2 } from "lucide-react";
import {
  createContext,
  type ReactNode,
  use,
  useRef,
  useState,
  useTransition,
} from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Shared sign-in pieces. Google and dev each pick a provider so the buttons
// don't know whether pending comes from a native `<form action>` (needed so
// Set-Cookie still flows through Better Auth's `nextCookies`) or a client
// Better Auth call during MCP OAuth.

export interface SignInState {
  error: string | null;
  pending: boolean;
}

export interface SignInActions {
  submit: (formData?: FormData) => void;
}

interface SignInContextValue {
  actions: SignInActions;
  state: SignInState;
}

const SignInContext = createContext<SignInContextValue | null>(null);

export function useSignIn(): SignInContextValue {
  const ctx = use(SignInContext);
  if (!ctx) {
    throw new Error(
      "SignIn pieces must render inside SignIn.Provider or SignIn.Frame"
    );
  }
  return ctx;
}

function unexpectedClientSubmit() {
  throw new Error("Server sign-in posts the form action; do not call submit()");
}

const SIGNING_IN_LABEL = (
  <>
    <Loader2 className="animate-spin" />
    Signing in…
  </>
);

function SignInProvider({
  actions,
  children,
  state,
}: {
  actions: SignInActions;
  children: ReactNode;
  state: SignInState;
}) {
  return <SignInContext value={{ actions, state }}>{children}</SignInContext>;
}

function FormStatusProvider({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <SignInContext
      value={{
        actions: { submit: unexpectedClientSubmit },
        state: { error: null, pending },
      }}
    >
      {children}
    </SignInContext>
  );
}

function SignInFrame({
  action,
  children,
  className,
}: {
  action: (formData: FormData) => Promise<void>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <form action={action} className={className}>
      <FormStatusProvider>{children}</FormStatusProvider>
    </form>
  );
}

function SignInClientFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const {
    actions: { submit },
  } = useSignIn();

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
    >
      {children}
    </form>
  );
}

function SignInSubmit({
  children,
  className,
  size,
}: {
  children: ReactNode;
  className?: string;
  size?: "default" | "lg";
}) {
  const {
    state: { pending },
  } = useSignIn();

  return (
    <Button
      aria-busy={pending}
      className={className}
      disabled={pending}
      size={size}
      type="submit"
      variant="outline"
    >
      {pending ? SIGNING_IN_LABEL : children}
    </Button>
  );
}

function SignInError({ className }: { className?: string }) {
  const {
    state: { error },
  } = useSignIn();

  return error ? (
    <p className={cn("text-destructive text-sm", className)} role="alert">
      {error}
    </p>
  ) : null;
}

// `handoff` keeps "Signing in…" up after success so the idle label doesn't
// flash before the browser follows the redirect.
export function useClientSignIn(
  run: (formData?: FormData) => Promise<string | null>,
  fallbackError: string
): SignInContextValue {
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [isPending, startTransition] = useTransition();
  const runRef = useRef(run);
  runRef.current = run;

  const submit = (formData?: FormData) => {
    setError(null);
    setHandoff(false);
    startTransition(async () => {
      try {
        const message = await runRef.current(formData);
        if (message) {
          setError(message);
          return;
        }
        setHandoff(true);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : fallbackError);
      }
    });
  };

  return {
    actions: { submit },
    state: { error, pending: isPending || handoff },
  };
}

export const SignIn = {
  ClientFrame: SignInClientFrame,
  Error: SignInError,
  Frame: SignInFrame,
  Provider: SignInProvider,
  Submit: SignInSubmit,
};

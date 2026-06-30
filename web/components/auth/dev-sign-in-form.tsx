import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/lib/auth";

// Dev-only password-less sign-in. Shared between `/login` (the dedicated
// sign-in route) and the in-page `SignInRequired` gate so both surfaces
// render the same affordance and never drift. The component itself does
// not check `isDevAuthEnabled` — call sites are expected to do that —
// because rendering this form is meaningless unless the matching
// Credentials provider is registered in `lib/auth.ts`.
//
// `inputId` is parameterized to keep the `<label htmlFor>` association
// unique if both gates ever render in the same React tree (e.g. while
// debugging).
export function DevSignInForm({
  callbackUrl,
  inputId = "dev-sign-in-email",
}: {
  callbackUrl: string;
  inputId?: string;
}) {
  return (
    <div className="w-full border-border border-t pt-6">
      <p className="mb-3 text-center text-muted-foreground text-xs uppercase tracking-wider">
        Local development
      </p>
      <form
        action={async (formData: FormData) => {
          "use server";
          if (process.env.NODE_ENV === "production") {
            throw new Error("Dev sign-in is disabled in production");
          }
          const email = formData.get("email");
          await signIn("dev", {
            email: typeof email === "string" ? email : "",
            redirectTo: callbackUrl,
          });
        }}
        className="flex w-full flex-col gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={inputId}>Email</Label>
          <Input
            defaultValue="dev@local"
            id={inputId}
            name="email"
            placeholder="dev@local"
            required
            type="email"
          />
        </div>
        <Button
          className="w-full cursor-pointer"
          type="submit"
          variant="outline"
        >
          Sign in (dev)
        </Button>
      </form>
    </div>
  );
}

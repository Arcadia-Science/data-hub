"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

// Browsers fill saved passwords into password fields even with
// autocomplete="off", and a paste then lands after the filled text.
// `new-password` and the password-manager ignore attributes stop that.
export function SecretInput({
  className,
  disabled,
  ...props
}: Omit<ComponentProps<"input">, "autoComplete" | "spellCheck" | "type">) {
  const [shown, setShown] = useState(false);
  return (
    <InputGroup
      className={className}
      data-disabled={disabled ? "true" : undefined}
    >
      <InputGroupInput
        {...props}
        autoCapitalize="off"
        autoComplete="new-password"
        autoCorrect="off"
        className="font-mono"
        data-1p-ignore=""
        data-bwignore=""
        data-form-type="other"
        data-lpignore="true"
        disabled={disabled}
        spellCheck={false}
        type={shown ? "text" : "password"}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          aria-label={shown ? "Hide secret" : "Show secret"}
          aria-pressed={shown}
          disabled={disabled}
          onClick={() => setShown((current) => !current)}
          size="icon-xs"
        >
          {shown ? (
            <EyeOffIcon aria-hidden="true" />
          ) : (
            <EyeIcon aria-hidden="true" />
          )}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

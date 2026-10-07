"use client";

import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const STEP_GRID = "grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-4";

export function SetupSteps({ children }: { children: ReactNode }) {
  return (
    <ol aria-label="Linear setup" className="divide-y">
      {children}
    </ol>
  );
}

export function ExternalLinkButton({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a
      className={buttonVariants({ size: "sm", variant: "outline" })}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLinkIcon aria-hidden="true" data-icon="inline-end" />
    </a>
  );
}

function StepMarker({
  number,
  state,
}: {
  number?: number;
  state: "active" | "done" | "next";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full font-semibold text-xs",
        state === "active" && "bg-foreground text-background",
        state === "done" &&
          "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
        state === "next" &&
          "bg-background text-muted-foreground ring-1 ring-border ring-inset"
      )}
    >
      {state === "done" ? <CheckIcon className="size-3.5" /> : number}
    </span>
  );
}

export function CompletedStep({
  detail,
  onChange,
  title,
}: {
  detail: string;
  onChange?: () => void;
  title: string;
}) {
  return (
    <li className="px-6 py-4">
      <div className={STEP_GRID}>
        <StepMarker state="done" />
        <div>
          <h3 className="font-semibold text-sm leading-6">
            <span className="sr-only">Done: </span>
            {title}
          </h3>
          <p className="text-pretty text-muted-foreground text-sm">{detail}</p>
        </div>
        {onChange ? (
          <Button onClick={onChange} size="sm" type="button" variant="ghost">
            Change
            <span className="sr-only">: {title}</span>
          </Button>
        ) : (
          <span />
        )}
      </div>
    </li>
  );
}

export function UpcomingStep({
  description,
  number,
  title,
}: {
  description: string;
  number: number;
  title: string;
}) {
  return (
    <li className="px-6 py-5">
      <div className={STEP_GRID}>
        <StepMarker number={number} state="next" />
        <div>
          <h3 className="font-semibold text-neutral-600 text-sm leading-6 dark:text-neutral-400">
            <span className="sr-only">Not started: </span>
            {title}
          </h3>
          <p className="text-pretty text-muted-foreground text-sm">
            {description}
          </p>
        </div>
      </div>
    </li>
  );
}

// `focusHeading` is set when the admin moved here from another step, so
// keyboard and screen reader users land on the new step. It stays off on the
// first page load, where moving focus would scroll the page.
export function CurrentStep({
  children,
  description,
  focusHeading,
  number,
  title,
}: {
  children: ReactNode;
  description: string;
  focusHeading: boolean;
  number: number;
  title: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) {
      headingRef.current?.focus();
    }
  }, [focusHeading]);

  return (
    <li aria-current="step" className="px-6 py-5">
      <div className={STEP_GRID}>
        <StepMarker number={number} state="active" />
        <div>
          <h3
            className="rounded-sm font-semibold text-sm leading-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            ref={headingRef}
            tabIndex={-1}
          >
            <span className="sr-only">Current step: </span>
            {title}
          </h3>
          <p className="text-pretty text-muted-foreground text-sm">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-4 flex min-w-0 flex-col gap-5 sm:ml-10">
        {children}
      </div>
    </li>
  );
}

export function InLinearInstructions({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <div className="rounded-lg bg-muted/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-semibold text-sm">In Linear</h4>
        <ExternalLinkButton href={href}>Open in Linear</ExternalLinkButton>
      </div>
      <ol className="mt-3 flex list-decimal flex-col gap-2.5 pl-5 text-sm leading-normal marker:text-muted-foreground">
        {children}
      </ol>
    </div>
  );
}

// A read-only field with a copy button, such as the callback URL. `label`
// names the field for screen readers and the copy button.
export function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 flex gap-2">
      <Input
        aria-label={label}
        autoComplete="off"
        className="font-mono text-[13px]"
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        spellCheck={false}
        translate="no"
        value={value}
      />
      <CopyButton
        label={`Copy ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
        value={value}
      />
    </div>
  );
}

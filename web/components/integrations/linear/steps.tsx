"use client";

import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";

export function SetupSteps({ children }: { children: ReactNode }) {
  return <div className="divide-y">{children}</div>;
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
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="flex gap-3">
        <CheckIcon
          aria-hidden="true"
          className="mt-0.5 size-4 text-green-600"
        />
        <div>
          <p className="font-medium text-sm">{title}</p>
          <p className="text-muted-foreground text-sm">{detail}</p>
        </div>
      </div>
      {onChange ? (
        <Button onClick={onChange} size="sm" type="button" variant="ghost">
          Change
        </Button>
      ) : null}
    </div>
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
    <div className="flex gap-3 py-4 text-muted-foreground">
      <StepNumber number={number} />
      <div>
        <p className="font-medium text-foreground text-sm">{title}</p>
        <p className="text-sm">{description}</p>
      </div>
    </div>
  );
}

export function CurrentStep({
  children,
  description,
  number,
  title,
}: {
  children: ReactNode;
  description: string;
  number: number;
  title: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="flex gap-3 py-4">
      <StepNumber current number={number} />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div>
          <h3
            className="font-medium text-sm outline-none"
            ref={headingRef}
            tabIndex={-1}
          >
            {title}
          </h3>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function StepNumber({
  current = false,
  number,
}: {
  current?: boolean;
  number: number;
}) {
  return (
    <span
      aria-hidden="true"
      className={
        current
          ? "flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground font-medium text-[11px] text-background"
          : "flex size-5 shrink-0 items-center justify-center rounded-full border font-medium text-[11px] text-muted-foreground"
      }
    >
      {number}
    </span>
  );
}

export function InLinearInstructions({
  children,
  href,
  label = "In Linear",
}: {
  children: ReactNode;
  href: string;
  label?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-medium text-sm">{label}</p>
        <a
          className="inline-flex items-center gap-1 text-sm underline underline-offset-2"
          href={href}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open in Linear
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
        </a>
      </div>
      <ol className="flex flex-col gap-2 text-sm">{children}</ol>
    </div>
  );
}

export function CopyValue({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  return (
    <div className="mt-1 flex gap-2">
      <input
        aria-label={label}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
        id={id}
        readOnly
        value={value}
      />
      <CopyButton size="icon-sm" value={value} />
    </div>
  );
}

"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  className?: string;
  size?: React.ComponentProps<typeof Button>["size"];
  value: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
}

export function CopyButton({
  value,
  className,
  variant = "outline",
  size = "icon",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [value]);

  return (
    <Button
      aria-label="Copy to clipboard"
      className={cn(className)}
      onClick={handleCopy}
      size={size}
      variant={variant}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}

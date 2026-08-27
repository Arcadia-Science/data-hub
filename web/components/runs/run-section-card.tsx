import type { ReactNode } from "react";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// The frame every run-page section below the files table uses: a heading with
// an optional count, then one small card holding the content.
export function RunSectionCard({
  children,
  className,
  contentClassName,
  count,
  title,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  count?: number;
  title: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <RunSectionHeading countLabel={count} title={title} />
      <Card size="sm">
        <CardContent className={cn("flex flex-col gap-6", contentClassName)}>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

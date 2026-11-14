import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const noticeVariants = cva("flex gap-3 rounded-xl border px-4 py-3.5 text-sm", {
  variants: {
    tone: {
      // A change on its way.
      info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100",
      // Something the watcher couldn't do.
      danger:
        "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100",
      // Something that needs a restart, or a look.
      warning:
        "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
      // Context, not a problem.
      neutral:
        "border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-100",
    },
  },
  defaultVariants: { tone: "neutral" },
});

const ICON_COLORS = {
  info: "text-blue-600 dark:text-blue-300",
  danger: "text-red-600 dark:text-red-300",
  warning: "text-amber-600 dark:text-amber-300",
  neutral: "text-slate-600 dark:text-slate-300",
} as const;

/**
 * A full-width notice on the watcher page: an icon, a bold title, a sentence or
 * two, and optionally a row of actions. The title names the landmark.
 */
export function WatcherNotice({
  tone = "neutral",
  icon: Icon,
  title,
  children,
  actions,
  className,
}: VariantProps<typeof noticeVariants> & {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const resolvedTone = tone ?? "neutral";
  return (
    <section
      aria-label={title}
      className={cn(noticeVariants({ tone: resolvedTone }), className)}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-[18px] shrink-0", ICON_COLORS[resolvedTone])}
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-0.5 break-words">{children}</div> : null}
        {actions ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            {actions}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** A link inside a notice's action row. */
export const NOTICE_LINK_CLASSNAME =
  "inline-flex items-center gap-1 font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring rounded-sm";

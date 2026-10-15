import { Skeleton } from "@/components/ui/skeleton";

/**
 * A loading placeholder that screen readers can read. A bare skeleton with only
 * an `aria-label` gives them nothing to announce, so the label is real text.
 */
export function LoadingSkeleton({
  className,
  label,
}: {
  className: string;
  label: string;
}) {
  return (
    <div className={className} role="status">
      <span className="sr-only">{label}</span>
      <Skeleton aria-hidden className="size-full" />
    </div>
  );
}

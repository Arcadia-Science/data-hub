import { MessageSquare } from "lucide-react";

export function RunCommentCount({ count }: { count: number }) {
  if (count <= 0) {
    return null;
  }

  const label = count === 1 ? "1 comment" : `${count} comments`;

  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"
      title={label}
    >
      <MessageSquare aria-hidden className="size-3" />
      <span aria-hidden className="text-xs tabular-nums">
        {count}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

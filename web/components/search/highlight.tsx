import { Fragment } from "react";

// Escapes regex metacharacters so the query is matched literally — a filename
// query like `.*jpg` must highlight those characters, not act as a wildcard.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renders `text` with every case-insensitive occurrence of `query` wrapped in
 * an accent-colored highlight. This is the primary signal for *why* a result
 * matched, so it's applied to every field where the query can appear (title,
 * secondary line, and match-reason line).
 */
export function Highlight({
  text,
  query,
  className,
}: {
  text: string;
  query: string;
  className?: string;
}) {
  const trimmed = query.trim();
  if (!trimmed) {
    return <>{text}</>;
  }

  const lowerQuery = trimmed.toLowerCase();
  const markClassName =
    className ??
    "rounded-[3px] bg-primary/15 px-0.5 text-primary dark:bg-primary/25";

  // Split into segments and drop the empty strings the regex emits between
  // adjacent matches. A cumulative character offset gives every segment a
  // stable, unique key without relying on the array index.
  let offset = 0;
  const segments = text
    .split(new RegExp(`(${escapeRegExp(trimmed)})`, "gi"))
    .map((value) => {
      const start = offset;
      offset += value.length;
      return { value, start };
    })
    .filter((segment) => segment.value !== "");

  return (
    <>
      {segments.map((segment) =>
        segment.value.toLowerCase() === lowerQuery ? (
          <mark className={markClassName} key={segment.start}>
            {segment.value}
          </mark>
        ) : (
          <Fragment key={segment.start}>{segment.value}</Fragment>
        )
      )}
    </>
  );
}

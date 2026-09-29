/** Same blue as the mark in `public/images/data-hub-logo.svg`. */
export const dataHubMarkBlueClassName = "bg-[#5088C5]";

export function changelogDateHash(date: string): string {
  return `#${date}`;
}

/** Sentence under the page title. Omits the count when nothing is unseen. */
export function changelogIntro(unseenCount: number): string {
  const base = "What's changed in Data Hub, newest first.";
  if (unseenCount <= 0) {
    return base;
  }
  const noun = unseenCount === 1 ? "entry is" : "entries are";
  return `${base} ${unseenCount} ${noun} new to you.`;
}

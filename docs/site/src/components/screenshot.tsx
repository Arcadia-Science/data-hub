import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  SCREENSHOT_SCALE,
  type Screenshot as ScreenshotEntry,
  screenshots,
} from "@/lib/screenshots.generated";
import { DocsImage } from "./docs-image";

// MDX puts a standalone image inside a <p>, so everything here is a <span>.
// A <div> would be invalid HTML there and fail hydration.

const bySource = new Map(
  Object.values(screenshots).map((entry) => [entry.light.src, entry])
);

/** Finds the entry for an image imported by an MDX page, by its built URL. */
export function findScreenshot(src: unknown): ScreenshotEntry | undefined {
  if (!src || typeof src !== "object") {
    return;
  }
  const staticImage = "default" in src ? src.default : src;
  if (
    !staticImage ||
    typeof staticImage !== "object" ||
    !("src" in staticImage)
  ) {
    return;
  }
  return bySource.get(String(staticImage.src));
}

export function BrowserFrame({
  address,
  children,
  className,
}: {
  address: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        // `not-prose` drops the typography margin that every prose image gets,
        // which would otherwise sit inside the border.
        "not-prose block overflow-hidden rounded-xl border bg-fd-card shadow-sm",
        className
      )}
    >
      <span className="flex items-center gap-3 border-fd-border border-b bg-fd-muted/60 px-3 py-2">
        <span aria-hidden="true" className="flex shrink-0 items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="mx-auto min-w-0 max-w-md flex-1 truncate rounded-md bg-fd-background px-3 py-1 text-center text-fd-muted-foreground text-xs">
          {address}
        </span>
        {/* Balances the three dots so the address stays centered. */}
        <span aria-hidden="true" className="w-[3.25rem] shrink-0" />
      </span>
      {children}
    </span>
  );
}

// Both themes render, and CSS shows the one that matches. Lazy loading skips
// the hidden image, so a reader downloads one of the two.
function ThemedImage({
  alt,
  entry,
  preload,
  sizes,
}: {
  alt: string;
  entry: ScreenshotEntry;
  preload?: boolean;
  sizes?: string;
}) {
  return (
    <>
      <DocsImage
        alt={alt}
        className="dark:hidden"
        preload={preload}
        sizes={sizes}
        src={entry.light}
      />
      <DocsImage
        alt={alt}
        className="hidden dark:block"
        sizes={sizes}
        src={entry.dark}
      />
    </>
  );
}

export function Screenshot({
  alt,
  className,
  entry,
  preload,
  sizes,
}: {
  alt: string;
  className?: string;
  entry: ScreenshotEntry;
  preload?: boolean;
  sizes?: string;
}) {
  if (entry.kind === "window") {
    return (
      <BrowserFrame address={entry.address} className={className}>
        <ThemedImage alt={alt} entry={entry} preload={preload} sizes={sizes} />
      </BrowserFrame>
    );
  }

  // A close-up shows at the size it had on screen. Stretching a narrow dialog
  // to the width of the page would blur it.
  return (
    <span
      className={cn(
        "not-prose block overflow-hidden rounded-xl border shadow-sm",
        className
      )}
      style={{ maxWidth: `${entry.light.width / SCREENSHOT_SCALE}px` }}
    >
      <ThemedImage alt={alt} entry={entry} preload={preload} sizes={sizes} />
    </span>
  );
}

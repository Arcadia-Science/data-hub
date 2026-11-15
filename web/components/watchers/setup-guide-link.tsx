import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { DocsLink } from "@/components/docs-link";
import { NOTICE_LINK_CLASSNAME } from "@/components/watchers/watcher-notice";
import { ADD_INSTRUMENT_DOCS_URL } from "@/lib/docs";

/**
 * A link to the guide for setting up a watcher, which opens in a new tab. It
 * reads as a notice's text link; pass `className` to dress it as a button.
 */
export function SetupGuideLink({
  children,
  className = NOTICE_LINK_CLASSNAME,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <DocsLink className={className} href={ADD_INSTRUMENT_DOCS_URL}>
      {children}
      <ExternalLink aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </DocsLink>
  );
}

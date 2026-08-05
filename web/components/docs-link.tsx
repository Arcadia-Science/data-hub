import type { ComponentProps } from "react";

// Docs live in a separate app (Microfrontends `/docs` or an absolute origin).
// Always open in a new tab so the product session stays put.
export function DocsLink({
  href,
  children,
  ...props
}: Omit<ComponentProps<"a">, "href" | "rel" | "target"> & {
  href: string;
}) {
  return (
    <a {...props} href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

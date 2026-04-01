"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/instruments", label: "Instruments" },
  { href: "/settings", label: "Settings" },
] as const;

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-4">
      {links.map(({ href, label }) => {
        // Dashboard uses exact match so it doesn't highlight for every route;
        // other links use prefix match to stay active on nested pages
        // (e.g. /instruments/:id still highlights "Instruments").
        const isActive =
          href === "/"
            ? pathname === "/"
            : pathname === href || pathname.startsWith(`${href}/`);

        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "text-sm transition-colors hover:text-foreground",
              isActive ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

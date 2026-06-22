"use client";

import { useRouter } from "next/navigation";
import { TableRow } from "@/components/ui/table";

export function ClickableRow({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();

  return (
    <TableRow
      className={`group cursor-pointer ${className ?? ""}`}
      onClick={() => router.push(href)}
    >
      {children}
    </TableRow>
  );
}

"use client";

import { TableCell } from "@/components/ui/table";
import type { ReactNode } from "react";

/**
 * Wraps an `<InstrumentsTable>` actions cell so clicks inside it (edit
 * dialog trigger, approve/reject buttons, dropdown menus, etc.) don't
 * bubble up to the parent `<ClickableRow>` and trigger row navigation.
 *
 * Lives in its own client component file because the parent table is a
 * Server Component and can't pass `onClick` props across the boundary.
 */
export function RowActionsCell({ children }: { children: ReactNode }) {
  return <TableCell onClick={(e) => e.stopPropagation()}>{children}</TableCell>;
}

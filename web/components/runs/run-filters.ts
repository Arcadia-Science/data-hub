import { Trash2 } from "lucide-react";
import type { ComponentType } from "react";

export interface RunFilterValues {
  includeDeleted: boolean;
}

interface FilterDef {
  icon: ComponentType<{ className?: string }>;
  key: keyof RunFilterValues;
  label: string;
}

// Kept apart from the menu so the toolbar button can count active filters
// without importing the menu, which loads on demand.
export const RUN_FILTERS: readonly FilterDef[] = [
  { key: "includeDeleted", label: "Show deleted runs", icon: Trash2 },
] as const;

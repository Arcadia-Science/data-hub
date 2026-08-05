"use client";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";

export interface FilesFilterOption<T extends string> {
  label: string;
  value: T;
}

function triggerLabel<T extends string>(
  selected: T[],
  items: FilesFilterOption<T>[],
  placeholder: string
): string {
  if (selected.length === 0) {
    return placeholder;
  }
  if (selected.length === 1) {
    return (
      items.find((item) => item.value === selected[0])?.label ?? placeholder
    );
  }
  return `${placeholder} (${selected.length})`;
}

export function FilesFilterCombobox<T extends string>({
  "aria-label": ariaLabel,
  items,
  onValueChange,
  placeholder,
  value,
}: {
  "aria-label"?: string;
  items: FilesFilterOption<T>[];
  onValueChange: (next: T[]) => void;
  placeholder: string;
  value: T[];
}) {
  const itemValues = items.map((item) => item.value);
  const labelByValue = new Map(items.map((item) => [item.value, item.label]));

  return (
    <Combobox
      items={itemValues}
      itemToStringValue={(item) => labelByValue.get(item) ?? item}
      multiple
      onValueChange={(next) => onValueChange(next as T[])}
      value={value}
    >
      <ComboboxTrigger
        aria-label={ariaLabel ?? placeholder}
        render={
          <Button
            className="h-8 justify-between gap-1.5 font-normal text-sm"
            size="sm"
            variant="outline"
          />
        }
      >
        {triggerLabel(value, items, placeholder)}
      </ComboboxTrigger>
      <ComboboxContent className="min-w-40">
        <ComboboxList>
          {(item) => (
            <ComboboxItem key={item} value={item}>
              {labelByValue.get(item) ?? item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

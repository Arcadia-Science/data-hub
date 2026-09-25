"use client";

import { Check, ChevronDown } from "lucide-react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function CommentScopeFilter<const T extends string>({
  defaultValue,
  options,
  values,
}: {
  defaultValue: T;
  options: readonly { label: string; value: T }[];
  values: readonly T[];
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useQueryState(
    "comments",
    parseAsStringLiteral(values).withDefault(defaultValue).withOptions({
      clearOnDefault: true,
      shallow: true,
    })
  );
  const label =
    options.find((option) => option.value === value)?.label ??
    options[0]?.label;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button className="h-9 gap-2 font-normal" size="sm" variant="outline">
          <span className="text-sm">{label}</span>
          <ChevronDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-0">
        <div className="flex flex-col py-1">
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                className={cn(
                  "flex items-center justify-between px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
                  active && "font-medium"
                )}
                key={option.value}
                onClick={() => {
                  setValue(option.value);
                  setOpen(false);
                }}
                type="button"
              >
                <span>{option.label}</span>
                {active ? (
                  <Check className="size-3.5 text-muted-foreground" />
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

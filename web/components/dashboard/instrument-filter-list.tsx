"use client";

import { Check } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface Instrument {
  displayName: string;
  id: string;
}

// Lives in its own module so the toolbar can load the command menu library
// only when the popover opens.
export function InstrumentFilterList({
  instruments,
  onToggle,
  selectedIds,
}: {
  instruments: Instrument[];
  onToggle: (id: string) => void;
  selectedIds: string[];
}) {
  return (
    <Command>
      <CommandInput placeholder="Filter instruments…" />
      <CommandList>
        <CommandEmpty>No instruments found.</CommandEmpty>
        <CommandGroup>
          {instruments.map((inst) => {
            const selected = selectedIds.includes(inst.id);
            return (
              <CommandItem
                key={inst.id}
                onSelect={() => onToggle(inst.id)}
                value={inst.displayName}
              >
                <Check
                  className={cn(
                    "mr-2 size-4",
                    selected ? "opacity-100" : "opacity-0"
                  )}
                />
                {inst.displayName}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

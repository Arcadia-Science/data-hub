"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const NONE_VALUE = "";

interface VersionComboboxProps {
  ariaInvalid?: boolean;
  disabled?: boolean;
  id: string;
  noneLabel: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
  versions: string[];
}

export function VersionCombobox({
  ariaInvalid,
  disabled,
  id,
  noneLabel,
  onBlur,
  onChange,
  placeholder = "Select a version",
  value,
  versions,
}: VersionComboboxProps) {
  const [open, setOpen] = useState(false);
  // Keep a saved value that isn't on PyPI selectable (test pins like
  // `9.9.9`, yanked releases, or a version published after our cache).
  const currentMissing =
    value.length > 0 && !versions.includes(value) ? value : null;

  function select(next: string) {
    onChange(next);
    setOpen(false);
  }

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          onBlur?.();
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-invalid={ariaInvalid}
          className="h-9 w-full justify-between font-mono font-normal"
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
          variant="outline"
        >
          <span className={cn(value.length === 0 && "text-muted-foreground")}>
            {value.length > 0 ? value : placeholder}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput placeholder="Search versions..." />
          <CommandList>
            <CommandEmpty>No versions found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                data-checked={value.length === 0}
                onSelect={() => select(NONE_VALUE)}
                value={noneLabel}
              >
                <Check
                  className={cn(
                    "size-4",
                    value.length === 0 ? "opacity-100" : "opacity-0"
                  )}
                />
                <span className="text-muted-foreground">{noneLabel}</span>
              </CommandItem>
            </CommandGroup>
            {currentMissing ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Current">
                  <CommandItem
                    data-checked
                    onSelect={() => select(currentMissing)}
                    value={`${currentMissing} current`}
                  >
                    <Check className="size-4 opacity-100" />
                    <span className="font-mono">
                      {currentMissing}{" "}
                      <span className="text-muted-foreground">(current)</span>
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
            <CommandSeparator />
            <CommandGroup heading="PyPI releases">
              {versions.map((version) => {
                const selected = value === version;
                return (
                  <CommandItem
                    data-checked={selected}
                    key={version}
                    onSelect={() => select(version)}
                    value={version}
                  >
                    <Check
                      className={cn(
                        "size-4",
                        selected ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="font-mono">{version}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

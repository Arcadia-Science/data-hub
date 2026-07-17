"use client";

import { ChevronsUpDown } from "lucide-react";
import { useId, useState } from "react";
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
  const listId = useId();
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
          aria-controls={listId}
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
          <CommandList id={listId}>
            <CommandEmpty>No versions found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                data-checked={value.length === 0}
                onSelect={() => select(NONE_VALUE)}
                value={noneLabel}
              >
                <span className="text-muted-foreground">{noneLabel}</span>
              </CommandItem>
            </CommandGroup>
            {currentMissing ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Current">
                  <CommandItem
                    data-checked={true}
                    onSelect={() => select(currentMissing)}
                    value={`${currentMissing} current`}
                  >
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
              {versions.map((version) => (
                <CommandItem
                  data-checked={value === version}
                  key={version}
                  onSelect={() => select(version)}
                  value={version}
                >
                  <span className="font-mono">{version}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

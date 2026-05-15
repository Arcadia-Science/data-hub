"use client";

import { Checkbox } from "@/components/ui/checkbox";

import { type FileRef, useFileSelection } from "./file-selection-provider";

export function FileSelectCheckbox({ fileRef }: { fileRef: FileRef }) {
  const { actions, meta } = useFileSelection();
  return (
    <Checkbox
      aria-label={`Select file ${fileRef.filename}`}
      checked={meta.isSelected(fileRef.id)}
      onCheckedChange={() => actions.toggle(fileRef)}
    />
  );
}

// Tri-state header checkbox: indeterminate when only some visible refs are
// selected, fully checked once every visible ref is in the selection map.
export function FileSelectAllCheckbox({ refs }: { refs: FileRef[] }) {
  const { actions, meta } = useFileSelection();
  const allSelected = meta.allSelected(refs);
  const someSelected = !allSelected && meta.someSelected(refs);
  return (
    <Checkbox
      aria-label="Select all files on this page"
      checked={allSelected ? true : someSelected ? "indeterminate" : false}
      disabled={refs.length === 0}
      onCheckedChange={() => actions.selectMany(refs)}
    />
  );
}

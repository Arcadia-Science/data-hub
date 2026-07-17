"use client";

import type { ReactNode } from "react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { VersionCombobox } from "@/components/watcher-release/version-combobox";
import type { WatcherVersionOption } from "@/lib/pypi";

interface VersionFieldProps {
  availableVersions: WatcherVersionOption[];
  description: ReactNode;
  errors?: Array<{ message?: string } | undefined>;
  id: string;
  isInvalid: boolean;
  label: string;
  noneLabel: string;
  onBlur: () => void;
  onChange: (value: string) => void;
  placeholder: string;
  pypiReachable: boolean;
  value: string;
}

/**
 * Shared latest / min-supported version control. Owns the PyPI combobox
 * vs free-text fallback so the two form fields stay in sync.
 */
export function VersionField({
  availableVersions,
  description,
  errors,
  id,
  isInvalid,
  label,
  noneLabel,
  onBlur,
  onChange,
  placeholder,
  pypiReachable,
  value,
}: VersionFieldProps) {
  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {pypiReachable ? (
        <VersionCombobox
          ariaInvalid={isInvalid}
          id={id}
          noneLabel={noneLabel}
          onBlur={onBlur}
          onChange={onChange}
          placeholder="Select a version"
          value={value}
          versions={availableVersions}
        />
      ) : (
        <Input
          aria-invalid={isInvalid}
          autoComplete="off"
          className="font-mono"
          id={id}
          name={id}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          value={value}
        />
      )}
      <FieldDescription>
        {description}
        {pypiReachable ? null : (
          <> PyPI is unreachable, so versions must be entered manually.</>
        )}
      </FieldDescription>
      {isInvalid ? <FieldError errors={errors} /> : null}
    </Field>
  );
}

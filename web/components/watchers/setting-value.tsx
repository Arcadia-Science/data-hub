"use client";

import { FilePatterns } from "@/components/instruments/file-patterns";
import type { CurrentSettingValue } from "@/lib/watchers/current-settings";

/**
 * One value in the Current settings list: a path in the monospace face, the
 * file patterns as badges with their tooltip, or plain text. A client
 * component because `FilePatterns` carries a tooltip.
 */
export function SettingValue({ value }: { value: CurrentSettingValue }) {
  switch (value.kind) {
    case "mono":
      return (
        <span className="break-all font-mono text-[13px]">{value.text}</span>
      );
    case "patterns":
      return <FilePatterns patterns={value.patterns} />;
    default:
      return <>{value.text}</>;
  }
}

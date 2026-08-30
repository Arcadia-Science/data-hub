import { type ZodType, z } from "zod";
import type { McpToolAnnotations } from "@/lib/mcp/catalog/types";
import type { McpToolUiMeta } from "@/lib/mcp/ui-apps";

/** Config object passed to `server.registerTool` (name is separate). */
export function toolRegistrationConfig<
  TSchema extends Record<string, ZodType>,
  TAnnotations extends McpToolAnnotations | undefined,
  TOutput extends ZodType | undefined = undefined,
>(def: {
  title: string;
  description: string;
  inputSchema: TSchema;
  outputSchema?: TOutput;
  annotations?: TAnnotations;
  _meta?: McpToolUiMeta;
}): {
  title: string;
  description: string;
  inputSchema: z.ZodObject<TSchema>;
  outputSchema?: TOutput;
  annotations: TAnnotations;
  _meta?: McpToolUiMeta;
};
export function toolRegistrationConfig<
  TAnnotations extends McpToolAnnotations | undefined,
  TOutput extends ZodType | undefined = undefined,
>(def: {
  title: string;
  description: string;
  inputSchema?: undefined;
  outputSchema?: TOutput;
  annotations?: TAnnotations;
  _meta?: McpToolUiMeta;
}): {
  title: string;
  description: string;
  outputSchema?: TOutput;
  annotations: TAnnotations;
  _meta?: McpToolUiMeta;
};
export function toolRegistrationConfig(def: {
  title: string;
  description: string;
  inputSchema?: Record<string, ZodType>;
  outputSchema?: ZodType;
  annotations?: McpToolAnnotations;
  _meta?: McpToolUiMeta;
}) {
  return {
    title: def.title,
    description: def.description,
    // SDK v2 expects a ZodObject; defs keep a raw shape so the catalog can
    // still iterate field metadata without unwrapping. Omit the key when
    // absent so registerTool picks the no-args callback overload.
    ...(def.inputSchema ? { inputSchema: z.object(def.inputSchema) } : {}),
    // Pass through as a whole schema — do not wrap with z.object().
    // Discriminated unions (e.g. get_run_archive) must stay intact.
    ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    annotations: def.annotations,
    ...(def._meta ? { _meta: def._meta } : {}),
  };
}

/** Config object passed to `server.registerPrompt` (name is separate). */
export function promptRegistrationConfig<
  TSchema extends Record<string, ZodType>,
>(def: {
  title: string;
  description: string;
  argsSchema: TSchema;
}): {
  title: string;
  description: string;
  argsSchema: z.ZodObject<TSchema>;
};
export function promptRegistrationConfig(def: {
  title: string;
  description: string;
  argsSchema?: undefined;
}): {
  title: string;
  description: string;
};
export function promptRegistrationConfig(def: {
  title: string;
  description: string;
  argsSchema?: Record<string, ZodType>;
}) {
  return {
    title: def.title,
    description: def.description,
    ...(def.argsSchema ? { argsSchema: z.object(def.argsSchema) } : {}),
  };
}

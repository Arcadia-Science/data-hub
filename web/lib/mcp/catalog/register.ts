import type { ZodType } from "zod";
import type { McpToolAnnotations } from "@/lib/mcp/catalog/types";

/** Config object passed to `server.registerTool` (name is separate). */
export function toolRegistrationConfig<
  TSchema extends Record<string, ZodType> | undefined,
  TAnnotations extends McpToolAnnotations | undefined,
>(def: {
  title: string;
  description: string;
  inputSchema?: TSchema;
  annotations?: TAnnotations;
}): {
  title: string;
  description: string;
  inputSchema: TSchema;
  annotations: TAnnotations;
} {
  return {
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema as TSchema,
    annotations: def.annotations as TAnnotations,
  };
}

/** Config object passed to `server.registerPrompt` (name is separate). */
export function promptRegistrationConfig<
  TSchema extends Record<string, ZodType> | undefined,
>(def: {
  title: string;
  description: string;
  argsSchema?: TSchema;
}): {
  title: string;
  description: string;
  argsSchema: TSchema;
} {
  return {
    title: def.title,
    description: def.description,
    argsSchema: def.argsSchema as TSchema,
  };
}

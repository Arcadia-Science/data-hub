import type {
  McpServer,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { type ZodType, z } from "zod";
import { openOutputJsonSchema } from "@/lib/mcp/catalog/json-schema";
import type { McpToolAnnotations } from "@/lib/mcp/catalog/types";
import type { McpToolUiMeta } from "@/lib/mcp/ui-apps";

/** A Zod output schema after `openOutputSchema`, in the form `registerTool` takes. */
export type OpenOutputSchema<TOutput extends ZodType | undefined> =
  TOutput extends ZodType
    ? StandardSchemaWithJSON<z.input<TOutput>, z.output<TOutput>>
    : undefined;

/**
 * Wrap an output schema so the JSON Schema we advertise is open (see
 * `openOutputJsonSchema`) while the SDK still validates with the schema
 * itself. The SDK reads only `~standard` from an output schema: `validate` to
 * check a result, `jsonSchema.output` to build `tools/list`.
 */
export function openOutputSchema<TSchema extends StandardSchemaWithJSON>(
  schema: TSchema
): StandardSchemaWithJSON<
  StandardSchemaWithJSON.InferInput<TSchema>,
  StandardSchemaWithJSON.InferOutput<TSchema>
> {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: standard.jsonSchema.input,
        output: (options) =>
          openOutputJsonSchema(standard.jsonSchema.output(options)),
      },
    },
  } as StandardSchemaWithJSON<
    StandardSchemaWithJSON.InferInput<TSchema>,
    StandardSchemaWithJSON.InferOutput<TSchema>
  >;
}

function isStandardSchemaWithJson(
  value: unknown
): value is StandardSchemaWithJSON {
  const standard = (value as StandardSchemaWithJSON | undefined)?.["~standard"];
  return (
    typeof standard?.validate === "function" &&
    typeof standard.jsonSchema?.output === "function"
  );
}

/**
 * Return `server` with a `registerTool` that opens each tool's Zod output
 * schema. Pass it to code that calls `server.registerTool` itself, such as the
 * feedback package, so its tools stay open like the ones built with
 * `toolRegistrationConfig`.
 */
export function withOpenOutputSchemas(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      if (property !== "registerTool") {
        return value.bind(target);
      }
      return (name: string, config: { outputSchema?: unknown }, cb: unknown) =>
        Reflect.apply(value, target, [
          name,
          isStandardSchemaWithJson(config.outputSchema)
            ? { ...config, outputSchema: openOutputSchema(config.outputSchema) }
            : config,
          cb,
        ]);
    },
  });
}

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
  outputSchema?: OpenOutputSchema<TOutput>;
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
  outputSchema?: OpenOutputSchema<TOutput>;
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
    // Pass the whole schema, don't wrap it with z.object(): discriminated
    // unions (e.g. get_run_archive) must stay intact. `openOutputSchema` opens
    // only the JSON Schema we advertise. Validation still uses the Zod schema.
    ...(def.outputSchema
      ? { outputSchema: openOutputSchema(def.outputSchema) }
      : {}),
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

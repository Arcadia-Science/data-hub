/**
 * Compact Markdown for generated OpenAPI operation pages.
 * Avoids embedding the full bundled schema (which ballooned `/llms-full.txt`).
 */

interface JsonSchema {
  $ref?: string;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  deprecated?: boolean;
  description?: string;
  enum?: unknown[];
  format?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string | string[];
  [key: string]: unknown;
}

interface OpenApiParameter {
  description?: string;
  in?: string;
  name: string;
  required?: boolean;
  schema?: JsonSchema;
}

interface OpenApiOperation {
  description?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: JsonSchema }>;
    description?: string;
    required?: boolean;
  };
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: JsonSchema }>;
      description?: string;
    }
  >;
  summary?: string;
  tags?: string[];
}

interface OpenApiDocument {
  components?: { schemas?: Record<string, JsonSchema> };
  paths?: Record<string, Partial<Record<string, OpenApiOperation>>>;
  webhooks?: Record<string, Partial<Record<string, OpenApiOperation>>>;
}

interface OperationRef {
  method: string;
  path: string;
}

interface WebhookRef {
  method: string;
  name: string;
}

export interface OpenApiPageLike {
  data: {
    description?: string;
    getOpenAPIPageProps: () => {
      operations?: OperationRef[];
      webhooks?: WebhookRef[];
    };
    // Fumadocs Document is wider than our read shape; cast inside the formatter.
    getSchema: () => { bundled: unknown };
    title?: string;
    _openapi?: { method?: string; webhook?: boolean };
  };
  url: string;
}

function refName(ref: string): string {
  const parts = ref.split("/");
  return parts.at(-1) ?? ref;
}

function formatSchemaType(schema: JsonSchema | undefined): string {
  if (!schema) {
    return "unknown";
  }
  if (schema.$ref) {
    return refName(schema.$ref);
  }
  if (schema.enum?.length) {
    return `enum(${schema.enum.map(String).join(" | ")})`;
  }
  if (schema.anyOf?.length) {
    return schema.anyOf.map((part) => formatSchemaType(part)).join(" | ");
  }
  const type = Array.isArray(schema.type)
    ? schema.type.join(" | ")
    : schema.type;
  if (type === "array") {
    return `${formatSchemaType(schema.items)}[]`;
  }
  if (schema.format) {
    return `${type ?? "object"} (${schema.format})`;
  }
  return type ?? "object";
}

function formatParameter(param: OpenApiParameter): string {
  const required = param.required ? "required" : "optional";
  const where = param.in ? ` in ${param.in}` : "";
  const type = formatSchemaType(param.schema);
  const description = param.description ? ` — ${param.description}` : "";
  return `- \`${param.name}\` (${required}${where}, \`${type}\`)${description}`;
}

function contentSchema(
  content: Record<string, { schema?: JsonSchema }> | undefined
): JsonSchema | undefined {
  if (!content) {
    return;
  }
  return (
    content["application/json"]?.schema ?? Object.values(content)[0]?.schema
  );
}

function formatObjectProps(schema: JsonSchema | undefined): string {
  if (!schema?.properties) {
    return "";
  }
  const required = new Set(schema.required ?? []);
  const lines = Object.entries(schema.properties).map(([name, prop]) => {
    const req = required.has(name) ? "required" : "optional";
    const deprecated = prop.deprecated ? ", deprecated" : "";
    const description = prop.description ? ` — ${prop.description}` : "";
    return `  - \`${name}\` (${req}${deprecated}, \`${formatSchemaType(prop)}\`)${description}`;
  });
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/**
 * Follows a `$ref` into `components.schemas`, so a response that names its
 * schema can still be read. Returns undefined for a reference it can't
 * resolve, or one that points back at itself.
 */
function resolveSchema(
  schema: JsonSchema | undefined,
  doc: OpenApiDocument
): JsonSchema | undefined {
  let current = schema;
  const seen = new Set<string>();
  while (current?.$ref) {
    const prefix = "#/components/schemas/";
    if (!current.$ref.startsWith(prefix) || seen.has(current.$ref)) {
      return;
    }
    seen.add(current.$ref);
    current = doc.components?.schemas?.[current.$ref.slice(prefix.length)];
  }
  return current;
}

/**
 * The properties of an object schema, including those of the schemas it
 * extends with `allOf`, reading through `$ref`s.
 */
function schemaProperties(
  schema: JsonSchema | undefined,
  doc: OpenApiDocument
): Record<string, JsonSchema> {
  const resolved = resolveSchema(schema, doc);
  const inherited = (resolved?.allOf ?? []).map((part) =>
    schemaProperties(part, doc)
  );
  return Object.assign({}, ...inherited, resolved?.properties);
}

/**
 * The deprecated properties of a response's schema, one line each. Responses
 * list only their type, so this is where a deprecated field shows up. It reads
 * through `$ref`s, `allOf` and the items of an array, and ignores anything
 * deeper.
 */
function deprecatedResponseProps(
  schema: JsonSchema | undefined,
  doc: OpenApiDocument
): string {
  const resolved = resolveSchema(schema, doc);
  const object = resolved?.type === "array" ? resolved.items : resolved;
  const lines = Object.entries(schemaProperties(object, doc))
    .filter(([, prop]) => (resolveSchema(prop, doc) ?? prop).deprecated)
    .map(([name, prop]) => {
      const description = prop.description ? ` — ${prop.description}` : "";
      return `  - \`${name}\` (deprecated, \`${formatSchemaType(prop)}\`)${description}`;
    });
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function formatOperationBody(
  method: string,
  pathOrName: string,
  operation: OpenApiOperation,
  kind: "operation" | "webhook",
  doc: OpenApiDocument
): string {
  const verb = method.toUpperCase();
  const target =
    kind === "webhook" ? `webhook \`${pathOrName}\`` : `\`${pathOrName}\``;
  const lines: string[] = [`\`${verb}\` ${target}`];

  if (operation.operationId) {
    lines.push(`\nOperation ID: \`${operation.operationId}\``);
  }
  if (operation.description) {
    lines.push(`\n${operation.description}`);
  }

  const params = operation.parameters ?? [];
  if (params.length > 0) {
    lines.push(`\n**Parameters**\n\n${params.map(formatParameter).join("\n")}`);
  }

  const body = operation.requestBody;
  if (body) {
    const schema = contentSchema(body.content);
    const required = body.required ? "required" : "optional";
    const description = body.description ? ` — ${body.description}` : "";
    const props = schema?.$ref ? "" : formatObjectProps(schema);
    lines.push(
      `\n**Request body** (${required}, \`${formatSchemaType(schema)}\`)${description}${props}`
    );
  }

  const responses = operation.responses ?? {};
  const responseLines = Object.entries(responses).map(([status, response]) => {
    const schema = contentSchema(response.content);
    const type = schema ? ` \`${formatSchemaType(schema)}\`` : "";
    const description = response.description
      ? ` — ${response.description}`
      : "";
    return `- \`${status}\`${type}${description}${deprecatedResponseProps(schema, doc)}`;
  });
  if (responseLines.length > 0) {
    lines.push(`\n**Responses**\n\n${responseLines.join("\n")}`);
  }

  return lines.join("");
}

export function openApiPageMarkdown(page: OpenApiPageLike): string {
  const props = page.data.getOpenAPIPageProps();
  const doc = page.data.getSchema().bundled as OpenApiDocument;
  const sections: string[] = [];

  if (page.data.description) {
    sections.push(page.data.description);
  }

  for (const item of props.operations ?? []) {
    const operation = doc.paths?.[item.path]?.[item.method.toLowerCase()];
    if (!operation) {
      sections.push(
        `\`${item.method.toUpperCase()}\` \`${item.path}\`\n\n*Operation missing from schema.*`
      );
      continue;
    }
    sections.push(
      formatOperationBody(item.method, item.path, operation, "operation", doc)
    );
  }

  for (const item of props.webhooks ?? []) {
    const operation = doc.webhooks?.[item.name]?.[item.method.toLowerCase()];
    if (!operation) {
      continue;
    }
    sections.push(
      formatOperationBody(item.method, item.name, operation, "webhook", doc)
    );
  }

  const body =
    sections.length > 0
      ? sections.join("\n\n")
      : "*No operations on this page.*";

  return `# ${page.data.title ?? "API"} (${page.url})

${body}`;
}

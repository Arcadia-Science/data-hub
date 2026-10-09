import {
  groupLabel,
  type McpCatalogDocument,
  type McpCatalogPrompt,
  type McpCatalogResource,
  type McpCatalogTool,
} from "@/lib/mcp-catalog";
import {
  getSchemaTree,
  type SchemaField,
  type SchemaTree,
  type SchemaVariant,
} from "@/lib/mcp-schema";

function annotationLine(tool: McpCatalogTool): string {
  const hints: string[] = [];
  if (tool.annotations?.readOnlyHint) {
    hints.push("readOnly");
  }
  if (tool.annotations?.idempotentHint) {
    hints.push("idempotent");
  }
  if (tool.annotations?.destructiveHint) {
    hints.push("destructive");
  }
  return hints.length > 0 ? `\n\n*${hints.join(" · ")}*` : "";
}

function formatFieldLine(
  field: SchemaField,
  indent: string,
  qualifier?: string
): string {
  const description = field.description ? ` — ${field.description}` : "";
  const meta = qualifier
    ? `(${qualifier}, \`${field.type}\`)`
    : `(\`${field.type}\`)`;
  return `${indent}- \`${field.name}\` ${meta}${description}`;
}

function formatNestedFields(
  field: SchemaField,
  indent: string,
  format: (nested: SchemaField, childIndent: string) => string
): string {
  const childIndent = `${indent}  `;
  const children =
    field.fields?.map((child) => format(child, childIndent)).join("\n") ?? "";
  const variants =
    field.variants
      ?.map((variant) => formatVariant(variant, childIndent, format))
      .join("\n") ?? "";
  return [children, variants].filter((part) => part.length > 0).join("\n");
}

function formatParameterField(field: SchemaField, indent: string): string {
  const qualifier = field.required ? "required" : "optional";
  const line = formatFieldLine(field, indent, qualifier);
  const nested = formatNestedFields(field, indent, formatParameterField);
  return nested.length > 0 ? `${line}\n${nested}` : line;
}

function formatResponseField(field: SchemaField, indent: string): string {
  const line = formatFieldLine(field, indent);
  const nested = formatNestedFields(field, indent, formatResponseField);
  return nested.length > 0 ? `${line}\n${nested}` : line;
}

function formatVariant(
  variant: SchemaVariant,
  indent: string,
  format: (field: SchemaField, childIndent: string) => string
): string {
  const heading = `${indent}- **${variant.label}**`;
  if (variant.fields.length === 0) {
    return heading;
  }
  const fields = variant.fields
    .map((field) => format(field, `${indent}  `))
    .join("\n");
  return `${heading}\n${fields}`;
}

function formatTree(
  tree: SchemaTree,
  indent: string,
  format: (field: SchemaField, childIndent: string) => string
): string {
  if (tree.variants !== undefined && tree.variants.length > 0) {
    return tree.variants
      .map((variant) => formatVariant(variant, indent, format))
      .join("\n");
  }

  return tree.fields.map((field) => format(field, indent)).join("\n");
}

function formatSchema(
  schema: Record<string, unknown> | undefined,
  label: string,
  format: (field: SchemaField, indent: string) => string
): string {
  const tree = getSchemaTree(schema);
  if (tree.empty) {
    return `\n\n*${label}: none.*`;
  }

  const body = formatTree(tree, "", format);
  if (tree.variants !== undefined && tree.variants.length > 0) {
    return `\n\n**${label}** (one of)\n\n${body}`;
  }

  return `\n\n**${label}**\n\n${body}`;
}

function formatTool(tool: McpCatalogTool): string {
  const heading = `### \`${tool.name}\``;
  return `${heading}\n\n${tool.description}${annotationLine(tool)}${formatSchema(tool.inputSchema, "Parameters", formatParameterField)}${formatSchema(tool.outputSchema, "Response", formatResponseField)}`;
}

function formatPrompt(prompt: McpCatalogPrompt): string {
  const heading = `### \`${prompt.name}\``;
  return `${heading}\n\n${prompt.description}${formatSchema(prompt.argsSchema, "Arguments", formatParameterField)}`;
}

function formatResource(resource: McpCatalogResource): string {
  const uri = resource.uri ?? resource.uriTemplate ?? "";
  const mime = resource.mimeType ? `\n\n*${resource.mimeType}*` : "";
  const uriBlock = uri ? `\n\n**URI**\n\n\`${uri}\`` : "";
  return `### \`${resource.name}\`\n\n${resource.description}${mime}${uriBlock}`;
}

export function toolsCatalogMarkdown(catalog: McpCatalogDocument): string {
  const byGroup = new Map<string, McpCatalogTool[]>();
  for (const tool of catalog.tools) {
    const list = byGroup.get(tool.group) ?? [];
    list.push(tool);
    byGroup.set(tool.group, list);
  }

  const sections = [...byGroup.entries()].map(([group, tools]) => {
    const body = tools.map(formatTool).join("\n\n");
    return `## ${groupLabel(group)}\n\n${body}`;
  });

  return sections.join("\n\n");
}

export function promptsCatalogMarkdown(catalog: McpCatalogDocument): string {
  return catalog.prompts.map(formatPrompt).join("\n\n");
}

export function resourcesCatalogMarkdown(catalog: McpCatalogDocument): string {
  return catalog.resources.map(formatResource).join("\n\n");
}

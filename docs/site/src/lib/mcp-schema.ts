export interface SchemaParameter {
  description?: string;
  enumValues?: string[];
  name: string;
  required: boolean;
  type: string;
}

export interface SchemaField {
  description?: string;
  fields?: SchemaField[];
  name: string;
  required: boolean;
  type: string;
  variants?: SchemaVariant[];
}

export interface SchemaVariant {
  fields: SchemaField[];
  label: string;
}

export interface SchemaTree {
  empty: boolean;
  fields: SchemaField[];
  variants?: SchemaVariant[];
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requiredNames(schema: Record<string, unknown>): Set<string> {
  if (!Array.isArray(schema.required)) {
    return new Set();
  }
  return new Set(
    schema.required.filter(
      (value): value is string => typeof value === "string"
    )
  );
}

function unionMembers(
  schema: Record<string, unknown>
): Record<string, unknown>[] | undefined {
  const union = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(union)) {
    return;
  }
  return union.filter(isSchemaObject);
}

function isNullSchema(schema: Record<string, unknown>): boolean {
  return schema.type === "null" || schema.const === null;
}

function peelNullish(schema: Record<string, unknown>): {
  nullable: boolean;
  schema: Record<string, unknown>;
} {
  const members = unionMembers(schema);
  if (members === undefined) {
    return { schema, nullable: isNullSchema(schema) };
  }

  const nullish = members.filter(isNullSchema);
  const rest = members.filter((member) => !isNullSchema(member));
  if (nullish.length > 0 && rest.length === 1) {
    const [only] = rest;
    if (only !== undefined) {
      return { schema: only, nullable: true };
    }
  }

  return { schema, nullable: false };
}

function formatType(node: unknown): string {
  if (!isSchemaObject(node)) {
    return "unknown";
  }

  if (node.const !== undefined) {
    return JSON.stringify(node.const);
  }

  if (Array.isArray(node.enum)) {
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  }

  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const members = unionMembers(node) ?? [];
    return members.map(formatType).join(" | ");
  }

  if (Array.isArray(node.type)) {
    return node.type.map(String).join(" | ");
  }

  if (node.type === "array") {
    return `array<${formatType(node.items)}>`;
  }

  if (node.type === "object") {
    if (isSchemaObject(node.properties)) {
      return "object";
    }
    if (isSchemaObject(node.additionalProperties)) {
      const valueType = formatType(node.additionalProperties);
      if (
        valueType !== "unknown" &&
        Object.keys(node.additionalProperties).length > 0
      ) {
        return `record<string, ${valueType}>`;
      }
    }
    return "object";
  }

  if (typeof node.type === "string") {
    if (typeof node.format === "string") {
      return `${node.type} (${node.format})`;
    }
    return node.type;
  }

  return "unknown";
}

function variantLabel(schema: Record<string, unknown>, index: number): string {
  if (typeof schema.title === "string" && schema.title.length > 0) {
    return schema.title;
  }

  if (!isSchemaObject(schema.properties)) {
    return `Option ${index + 1}`;
  }

  for (const [name, value] of Object.entries(schema.properties)) {
    if (isSchemaObject(value) && value.const !== undefined) {
      return `${name} = ${JSON.stringify(value.const)}`;
    }
  }

  return `Option ${index + 1}`;
}

function objectFields(
  schema: Record<string, unknown>
): SchemaField[] | undefined {
  if (!isSchemaObject(schema.properties)) {
    return;
  }

  const entries = Object.entries(schema.properties);
  if (entries.length === 0) {
    return;
  }

  const required = requiredNames(schema);
  return entries.map(([name, value]) => {
    const property = isSchemaObject(value) ? value : {};
    const peeled = peelNullish(property);
    const description =
      typeof property.description === "string"
        ? property.description
        : undefined;

    return {
      name,
      type: formatType(property),
      required: required.has(name),
      description,
      fields: collectFields(peeled.schema),
      variants: collectVariants(peeled.schema),
    };
  });
}

function collectFields(
  schema: Record<string, unknown>
): SchemaField[] | undefined {
  const fromObject = objectFields(schema);
  if (fromObject !== undefined) {
    return fromObject;
  }

  if (schema.type === "array" && isSchemaObject(schema.items)) {
    return collectFields(peelNullish(schema.items).schema);
  }

  return;
}

function collectVariants(
  schema: Record<string, unknown>
): SchemaVariant[] | undefined {
  const members = unionMembers(schema);
  if (members === undefined) {
    return;
  }

  const meaningful = members.filter((member) => !isNullSchema(member));
  if (meaningful.length < 2) {
    return;
  }

  const hasStructure = meaningful.some(
    (member) => isSchemaObject(member.properties) || Array.isArray(member.oneOf)
  );
  if (!hasStructure) {
    return;
  }

  return meaningful.map((member, index) => ({
    label: variantLabel(member, index),
    fields: objectFields(member) ?? [],
  }));
}

export function getSchemaParameters(
  schema: Record<string, unknown>
): SchemaParameter[] {
  return getSchemaTree(schema).fields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
    description: field.description,
  }));
}

export function isEmptyObjectSchema(schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return false;
  }
  if (schema.type !== "object") {
    return false;
  }
  const properties = schema.properties;
  return (
    properties == null ||
    (typeof properties === "object" &&
      Object.keys(properties as object).length === 0)
  );
}

export function getSchemaTree(
  schema: Record<string, unknown> | undefined
): SchemaTree {
  if (schema == null || isEmptyObjectSchema(schema)) {
    return { empty: true, fields: [] };
  }

  const variants = collectVariants(schema);
  if (variants !== undefined) {
    return { empty: false, fields: [], variants };
  }

  const fields = objectFields(schema) ?? [];
  if (fields.length === 0) {
    return { empty: true, fields: [] };
  }

  return { empty: false, fields };
}

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/cn";
import {
  getSchemaTree,
  type SchemaField,
  type SchemaTree,
  type SchemaVariant,
} from "@/lib/mcp-schema";

export function CatalogSection({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <section className="not-prose flex flex-col gap-4">
      <h2
        className="scroll-m-24 font-semibold text-fd-foreground text-xl tracking-tight"
        id={id}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function CatalogEntry({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden", className)}>{children}</Card>
  );
}

export function CatalogEntryHeader({ children }: { children: ReactNode }) {
  return (
    <>
      <CardHeader className="flex-row items-center justify-between gap-2.5 pb-4">
        {children}
      </CardHeader>
      <Separator />
    </>
  );
}

export function CatalogEntryName({
  id,
  as: Comp = "h3",
  children,
}: {
  id: string;
  as?: "h2" | "h3";
  children: ReactNode;
}) {
  return (
    <Comp
      className="scroll-m-24 font-mono font-semibold text-base text-fd-info leading-none"
      id={id}
    >
      <code>{children}</code>
    </Comp>
  );
}

export function CatalogEntryBadges({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}

export function CatalogEntryDescription({ children }: { children: ReactNode }) {
  return (
    <CardDescription className="text-fd-muted-foreground leading-relaxed">
      {children}
    </CardDescription>
  );
}

export function CatalogEntryBody({ children }: { children: ReactNode }) {
  return <CardContent>{children}</CardContent>;
}

export function CatalogEntryFieldGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium text-fd-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </p>
      {children}
    </div>
  );
}

/** Explicit annotation badge variants — prefer these over boolean props. */
export function ReadOnlyBadge() {
  return <Badge variant="success">readOnly</Badge>;
}

export function IdempotentBadge() {
  return <Badge variant="warning">idempotent</Badge>;
}

export function DestructiveBadge() {
  return <Badge variant="destructive">destructive</Badge>;
}

export function MimeTypeBadge({ children }: { children: ReactNode }) {
  return <Badge variant="outline">{children}</Badge>;
}

export function ToolAnnotationBadges({
  annotations,
}: {
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}) {
  const hasHints =
    annotations?.readOnlyHint ||
    annotations?.destructiveHint ||
    annotations?.idempotentHint;

  if (!hasHints) {
    return null;
  }

  return (
    <CatalogEntryBadges>
      {annotations?.readOnlyHint ? <ReadOnlyBadge /> : null}
      {annotations?.idempotentHint ? <IdempotentBadge /> : null}
      {annotations?.destructiveHint ? <DestructiveBadge /> : null}
    </CatalogEntryBadges>
  );
}

function RequiredMark() {
  return <span className="font-medium text-fd-error text-xs">required</span>;
}

function SchemaFieldLayout({
  field,
  nameAccessory,
  children,
}: {
  children?: ReactNode;
  field: SchemaField;
  nameAccessory?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <code className="font-medium font-mono text-fd-foreground text-sm">
          {field.name}
        </code>
        {nameAccessory}
      </div>
      <code className="font-mono text-fd-info text-xs opacity-80">
        {field.type}
      </code>
      {field.description ? (
        <p className="text-fd-muted-foreground text-sm leading-relaxed">
          {field.description}
        </p>
      ) : null}
      {children}
    </div>
  );
}

function SchemaFieldStack({
  FieldItem,
  fields,
}: {
  FieldItem: (props: { field: SchemaField }) => ReactNode;
  fields: SchemaField[];
}) {
  return (
    <div className="mt-2 flex flex-col gap-3 border-fd-border border-l pl-3">
      {fields.map((field) => (
        <FieldItem field={field} key={field.name} />
      ))}
    </div>
  );
}

function SchemaVariantList({
  FieldItem,
  variants,
}: {
  FieldItem: (props: { field: SchemaField }) => ReactNode;
  variants: SchemaVariant[];
}) {
  return (
    <div className="mt-2 flex flex-col gap-4">
      {variants.map((variant) => (
        <div className="flex flex-col gap-2" key={variant.label}>
          <p className="font-medium text-fd-muted-foreground text-xs">
            {variant.label}
          </p>
          {variant.fields.length > 0 ? (
            <SchemaFieldStack FieldItem={FieldItem} fields={variant.fields} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SchemaFieldNested({
  field,
  FieldItem,
}: {
  field: SchemaField;
  FieldItem: (props: { field: SchemaField }) => ReactNode;
}) {
  const nested =
    field.fields !== undefined && field.fields.length > 0
      ? field.fields
      : undefined;
  const variants =
    field.variants !== undefined && field.variants.length > 0
      ? field.variants
      : undefined;

  return (
    <>
      {variants ? (
        <SchemaVariantList FieldItem={FieldItem} variants={variants} />
      ) : null}
      {nested ? (
        <SchemaFieldStack FieldItem={FieldItem} fields={nested} />
      ) : null}
    </>
  );
}

function ParameterFieldItem({ field }: { field: SchemaField }) {
  return (
    <SchemaFieldLayout
      field={field}
      nameAccessory={field.required ? <RequiredMark /> : null}
    >
      <SchemaFieldNested FieldItem={ParameterFieldItem} field={field} />
    </SchemaFieldLayout>
  );
}

function ResponseFieldItem({ field }: { field: SchemaField }) {
  return (
    <SchemaFieldLayout field={field}>
      <SchemaFieldNested FieldItem={ResponseFieldItem} field={field} />
    </SchemaFieldLayout>
  );
}

function SchemaTreeView({
  FieldItem,
  tree,
}: {
  FieldItem: (props: { field: SchemaField }) => ReactNode;
  tree: SchemaTree;
}) {
  if (tree.variants !== undefined && tree.variants.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-fd-muted-foreground text-sm">One of:</p>
        <SchemaVariantList FieldItem={FieldItem} variants={tree.variants} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {tree.fields.map((field) => (
        <FieldItem field={field} key={field.name} />
      ))}
    </div>
  );
}

function SchemaFieldList({
  emptyLabel,
  FieldItem,
  schema,
}: {
  emptyLabel: string;
  FieldItem: (props: { field: SchemaField }) => ReactNode;
  schema?: Record<string, unknown>;
}) {
  const tree = getSchemaTree(schema);
  if (tree.empty) {
    return <p className="text-fd-muted-foreground text-sm">{emptyLabel}</p>;
  }

  return <SchemaTreeView FieldItem={FieldItem} tree={tree} />;
}

export function SchemaParameterList({
  emptyLabel,
  schema,
}: {
  emptyLabel: string;
  schema?: Record<string, unknown>;
}) {
  return (
    <SchemaFieldList
      emptyLabel={emptyLabel}
      FieldItem={ParameterFieldItem}
      schema={schema}
    />
  );
}

export function SchemaResponseList({
  emptyLabel,
  schema,
}: {
  emptyLabel: string;
  schema?: Record<string, unknown>;
}) {
  return (
    <SchemaFieldList
      emptyLabel={emptyLabel}
      FieldItem={ResponseFieldItem}
      schema={schema}
    />
  );
}

export function SchemaParameters({
  schema,
  label = "Parameters",
}: {
  schema: Record<string, unknown>;
  label?: string;
}) {
  const tree = getSchemaTree(schema);
  if (tree.empty) {
    return <p className="text-fd-muted-foreground text-sm">No parameters.</p>;
  }

  return (
    <CatalogEntryFieldGroup label={label}>
      <SchemaTreeView FieldItem={ParameterFieldItem} tree={tree} />
    </CatalogEntryFieldGroup>
  );
}

export function ResourceUri({ children }: { children: ReactNode }) {
  return (
    <CatalogEntryFieldGroup label="URI">
      <code className="break-all font-mono text-fd-info text-sm opacity-80">
        {children}
      </code>
    </CatalogEntryFieldGroup>
  );
}

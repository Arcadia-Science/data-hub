import {
  getMcpCatalog,
  groupLabel,
  type McpCatalogTool,
} from "@/lib/mcp-catalog";
import {
  CatalogSchemaAccordion,
  CatalogSchemaAccordionItem,
} from "./catalog-schema-accordion";
import {
  CatalogEntry,
  CatalogEntryBody,
  CatalogEntryDescription,
  CatalogEntryHeader,
  CatalogEntryName,
  CatalogSection,
  SchemaParameterList,
  SchemaResponseList,
  ToolAnnotationBadges,
} from "./catalog-shared";

function CatalogToolCard({ tool }: { tool: McpCatalogTool }) {
  return (
    <CatalogEntry>
      <CatalogEntryHeader>
        <CatalogEntryName id={tool.name}>{tool.name}</CatalogEntryName>
        <ToolAnnotationBadges annotations={tool.annotations} />
      </CatalogEntryHeader>
      <CatalogEntryBody>
        <CatalogEntryDescription>{tool.description}</CatalogEntryDescription>
        <CatalogSchemaAccordion>
          <CatalogSchemaAccordionItem title="Parameters" value="parameters">
            <SchemaParameterList
              emptyLabel="No parameters."
              schema={tool.inputSchema}
            />
          </CatalogSchemaAccordionItem>
          <CatalogSchemaAccordionItem title="Response" value="response">
            <SchemaResponseList
              emptyLabel="No response schema."
              schema={tool.outputSchema}
            />
          </CatalogSchemaAccordionItem>
        </CatalogSchemaAccordion>
      </CatalogEntryBody>
    </CatalogEntry>
  );
}

export function McpToolCatalog() {
  const catalog = getMcpCatalog();
  const byGroup = new Map<string, typeof catalog.tools>();

  for (const tool of catalog.tools) {
    const list = byGroup.get(tool.group) ?? [];
    list.push(tool);
    byGroup.set(tool.group, list);
  }

  const groups = [...byGroup.entries()];

  return (
    <div className="not-prose flex flex-col gap-10">
      {groups.map(([group, tools]) => (
        <CatalogSection id={group} key={group} title={groupLabel(group)}>
          <div className="flex flex-col gap-4">
            {tools.map((tool) => (
              <CatalogToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        </CatalogSection>
      ))}
    </div>
  );
}

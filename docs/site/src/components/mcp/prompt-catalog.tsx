import { getMcpCatalog } from "@/lib/mcp-catalog";
import {
  CatalogEntry,
  CatalogEntryBody,
  CatalogEntryDescription,
  CatalogEntryHeader,
  CatalogEntryName,
  SchemaParameters,
} from "./catalog-shared";

export function McpPromptCatalog() {
  const catalog = getMcpCatalog();

  return (
    <div className="not-prose flex flex-col gap-4">
      {catalog.prompts.map((prompt) => (
        <CatalogEntry key={prompt.name}>
          <CatalogEntryHeader>
            <CatalogEntryName as="h2" id={prompt.name}>
              {prompt.name}
            </CatalogEntryName>
          </CatalogEntryHeader>
          <CatalogEntryBody>
            <CatalogEntryDescription>
              {prompt.description}
            </CatalogEntryDescription>
            <SchemaParameters label="Arguments" schema={prompt.argsSchema} />
          </CatalogEntryBody>
        </CatalogEntry>
      ))}
    </div>
  );
}

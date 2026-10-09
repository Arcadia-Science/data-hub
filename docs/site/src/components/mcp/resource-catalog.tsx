import { getMcpCatalog } from "@/lib/mcp-catalog";
import {
  CatalogEntry,
  CatalogEntryBadges,
  CatalogEntryBody,
  CatalogEntryDescription,
  CatalogEntryHeader,
  CatalogEntryName,
  MimeTypeBadge,
  ResourceUri,
} from "./catalog-shared";

export function McpResourceCatalog() {
  const catalog = getMcpCatalog();

  return (
    <div className="not-prose flex flex-col gap-4">
      {catalog.resources.map((resource) => {
        const uri = resource.uri ?? resource.uriTemplate ?? "";

        return (
          <CatalogEntry key={resource.name}>
            <CatalogEntryHeader>
              <CatalogEntryName as="h2" id={resource.name}>
                {resource.name}
              </CatalogEntryName>
              {resource.mimeType ? (
                <CatalogEntryBadges>
                  <MimeTypeBadge>{resource.mimeType}</MimeTypeBadge>
                </CatalogEntryBadges>
              ) : null}
            </CatalogEntryHeader>
            <CatalogEntryBody>
              <CatalogEntryDescription>
                {resource.description}
              </CatalogEntryDescription>
              {uri ? <ResourceUri>{uri}</ResourceUri> : null}
            </CatalogEntryBody>
          </CatalogEntry>
        );
      })}
    </div>
  );
}

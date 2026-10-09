import type { TOCItemType } from "fumadocs-core/toc";
import {
  getMcpCatalog,
  groupLabel,
  type McpCatalogDocument,
} from "@/lib/mcp-catalog";

export function toolsCatalogToc(catalog: McpCatalogDocument): TOCItemType[] {
  const byGroup = new Map<string, typeof catalog.tools>();

  for (const tool of catalog.tools) {
    const list = byGroup.get(tool.group) ?? [];
    list.push(tool);
    byGroup.set(tool.group, list);
  }

  const items: TOCItemType[] = [];
  for (const [group, tools] of byGroup) {
    items.push({
      title: groupLabel(group),
      url: `#${group}`,
      depth: 2,
    });
    for (const tool of tools) {
      items.push({
        title: tool.name,
        url: `#${tool.name}`,
        depth: 3,
      });
    }
  }
  return items;
}

export function promptsCatalogToc(catalog: McpCatalogDocument): TOCItemType[] {
  return catalog.prompts.map((prompt) => ({
    title: prompt.name,
    url: `#${prompt.name}`,
    depth: 2,
  }));
}

export function resourcesCatalogToc(
  catalog: McpCatalogDocument
): TOCItemType[] {
  return catalog.resources.map((resource) => ({
    title: resource.name,
    url: `#${resource.name}`,
    depth: 2,
  }));
}

/** Extra TOC headings for MCP catalog pages (rendered by RSC, not MDX). */
export function getMcpPageToc(
  slugs: string[] | undefined
): TOCItemType[] | null {
  if (slugs?.[0] !== "mcp" || slugs.length !== 2) {
    return null;
  }

  const catalog = getMcpCatalog();
  switch (slugs[1]) {
    case "tools":
      return toolsCatalogToc(catalog);
    case "prompts":
      return promptsCatalogToc(catalog);
    case "resources":
      return resourcesCatalogToc(catalog);
    default:
      return null;
  }
}

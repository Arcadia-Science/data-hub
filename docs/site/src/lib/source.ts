import { docs } from "collections/server";
import { renderPlaceholder } from "fumadocs-core/mdx-plugins/remark-llms.runtime";
import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { cliCatalogMarkdown } from "./cli-catalog-markdown";
import { getMcpCatalog } from "./mcp-catalog";
import {
  promptsCatalogMarkdown,
  resourcesCatalogMarkdown,
  toolsCatalogMarkdown,
} from "./mcp-catalog-markdown";
import { openapi } from "./openapi";
import { openApiPageMarkdown } from "./openapi-markdown";
import { docsContentRoute, docsImageRoute, docsRoute } from "./shared";

const openapiSource = await openapi.staticSource({
  baseDir: "api",
  groupBy: "tag",
  meta: true,
});

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: openapiSource,
  },
  {
    baseUrl: docsRoute,
    plugins: [lucideIconsPlugin(), openapi.loaderPlugin()],
  }
);

export function getPageImage(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "image.png"];

  return {
    segments,
    url: `${docsImageRoute}/${segments.join("/")}`,
  };
}

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "content.md"];

  return {
    segments,
    url: `${docsContentRoute}/${segments.join("/")}`,
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  if (page.type === "openapi") {
    return openApiPageMarkdown(page);
  }

  const processed = await page.data.getText("processed");
  const body = await renderPlaceholder(processed, {
    Audience({ children }) {
      return `**For:** ${children.trim()}`;
    },
    McpToolCatalog() {
      return toolsCatalogMarkdown(getMcpCatalog());
    },
    McpPromptCatalog() {
      return promptsCatalogMarkdown(getMcpCatalog());
    },
    McpResourceCatalog() {
      return resourcesCatalogMarkdown(getMcpCatalog());
    },
    WatcherCliCatalog() {
      return cliCatalogMarkdown();
    },
  });

  return `# ${page.data.title} (${page.url})

${body}`;
}

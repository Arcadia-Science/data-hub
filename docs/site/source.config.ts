import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// You can customize Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      // Keep catalog components (and Audience) as placeholders so
      // getLLMText can expand them with catalog markdown.
      includeProcessedMarkdown: {
        mdxAsPlaceholder: [
          "Audience",
          "McpToolCatalog",
          "McpPromptCatalog",
          "McpResourceCatalog",
          "WatcherCliCatalog",
        ],
      },
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    // Convert fenced ```mermaid code blocks into the <Mermaid> client component.
    remarkPlugins: [remarkMdxMermaid],
    // Static-import local screenshots so next/image gets intrinsic width/height
    // (and a blur placeholder) instead of rendering an unsized <img>.
    remarkImageOptions: {
      placeholder: "blur",
    },
  },
});

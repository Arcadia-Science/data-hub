import { Step, Steps } from "fumadocs-ui/components/steps";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Audience } from "./audience";
import { WatcherCliCatalog } from "./cli/cli-catalog";
import { MdxImage } from "./docs-image";
import { McpPromptCatalog } from "./mcp/prompt-catalog";
import { McpResourceCatalog } from "./mcp/resource-catalog";
import { McpToolCatalog } from "./mcp/tool-catalog";
import { Mermaid } from "./mermaid";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    img: MdxImage,
    Steps,
    Step,
    Audience,
    Mermaid,
    McpToolCatalog,
    McpPromptCatalog,
    McpResourceCatalog,
    WatcherCliCatalog,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

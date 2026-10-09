// Writes the docs bundle the MCP server answers `search_docs` and `read_doc`
// from. Each deployment ships its own docs with the web app, so the output is
// committed under `web/`. CI regenerates it and fails when the committed copy
// is out of date. Run `make docs-catalogs` (or `npm run docs-corpus:generate`
// here) after changing a docs page or one of the other generated snapshots.
import { writeFile } from "node:fs/promises";
import { register as registerHooks } from "node:module";
import { flattenTree } from "fumadocs-core/page-tree";
import { register } from "fumadocs-mdx/node";

// `source.ts` imports MDX through the generated `.source/` files, which Node
// can only load with these hooks in place.
register();
registerHooks("./stub-assets-loader.mjs", import.meta.url);

const { getLLMText, source } = await import("../src/lib/source");

const OUTPUT = new URL(
  "../../../web/lib/mcp/docs/docs-corpus.snapshot.json",
  import.meta.url
);

// The catalog pages render from the MCP schema, which the connected client
// already receives. They would only repeat the tool list.
const EXCLUDED_SLUGS = new Set(["mcp/tools", "mcp/prompts", "mcp/resources"]);

// Pages keep the order of the site's navigation, so the page list an agent sees
// when a search finds nothing groups related topics together.
const order = flattenTree(source.getPageTree().children).map(
  (item) => item.url
);
const rank = (url: string) => {
  const index = order.indexOf(url);
  return index === -1 ? order.length : index;
};

const pages = source
  .getPages()
  .filter((page) => page.type !== "openapi")
  .filter((page) => !EXCLUDED_SLUGS.has(page.slugs.join("/")))
  .sort((a, b) => rank(a.url) - rank(b.url) || a.url.localeCompare(b.url));

const entries = await Promise.all(
  pages.map(async (page) => ({
    page: page.slugs.join("/"),
    title: page.data.title,
    description: page.data.description ?? "",
    markdown: await getLLMText(page),
  }))
);

await writeFile(OUTPUT, `${JSON.stringify({ pages: entries }, null, 2)}\n`);

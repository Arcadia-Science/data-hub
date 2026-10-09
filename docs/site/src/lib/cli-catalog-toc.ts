import type { TOCItemType } from "fumadocs-core/toc";
import {
  type CliCatalogCommand,
  type CliCatalogDocument,
  formatInvocation,
  getCliCatalog,
} from "@/lib/cli-catalog";

/** TOC entries matching the `h2` / `h3` ids rendered by `WatcherCliCatalog`. */
export function cliCatalogToc(catalog: CliCatalogDocument): TOCItemType[] {
  const items: TOCItemType[] = [
    {
      title: "Global flags",
      url: "#global-flags",
      depth: 2,
    },
  ];

  for (const command of catalog.command.commands ?? []) {
    appendCommandToc(items, command, 2);
  }

  return items;
}

function appendCommandToc(
  items: TOCItemType[],
  command: CliCatalogCommand,
  depth: number
): void {
  const id = command.path.join("-");
  const children = command.commands ?? [];

  items.push({
    title: formatInvocation(command.path),
    url: `#${id}`,
    depth,
  });

  for (const child of children) {
    if (child.commands && child.commands.length > 0) {
      appendCommandToc(items, child, Math.min(depth + 1, 6));
      continue;
    }
    // Leaf cards use CatalogEntryName id `${path.join("-")}-cmd`.
    items.push({
      title: formatInvocation(child.path),
      url: `#${child.path.join("-")}-cmd`,
      depth: Math.min(depth + 1, 6),
    });
  }
}

/**
 * Insert catalog headings after the MDX "Command reference" section so the
 * sidebar order matches the page (RSC headings are invisible to remark TOC).
 */
export function mergeCliCatalogToc(
  pageToc: TOCItemType[],
  catalogToc: TOCItemType[]
): TOCItemType[] {
  const index = pageToc.findIndex((item) => item.url === "#command-reference");
  if (index === -1) {
    return [...pageToc, ...catalogToc];
  }
  return [
    ...pageToc.slice(0, index + 1),
    ...catalogToc,
    ...pageToc.slice(index + 1),
  ];
}

/** Extra TOC headings for the Watcher CLI reference page. */
export function getCliPageToc(
  slugs: string[] | undefined
): TOCItemType[] | null {
  if (slugs?.length !== 1 || slugs[0] !== "cli-reference") {
    return null;
  }
  return cliCatalogToc(getCliCatalog());
}

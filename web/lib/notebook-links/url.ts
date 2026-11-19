// Rules for lab notebooks: which links are allowed, when two links point to
// the same page, what to call a page before someone names it, and the limits
// on names, descriptions, and runs. Both the browser and the server import
// this file, so keep server-only imports out of it.
//
// `notebookUrlKey` is stored in `notebooks.url_key`. If you change how it
// builds a key, recompute the key for existing rows, or duplicate checks and
// URL search will miss notebooks saved under the old rules.

import { z } from "zod";

export const NOTEBOOK_LINK_URL_MAX_LENGTH = 2048;
export const NOTEBOOK_NAME_MAX_LENGTH = 200;
export const NOTEBOOK_DESCRIPTION_MAX_LENGTH = 2000;
// How many notebooks one run can be in.
export const NOTEBOOKS_PER_RUN_MAX = 20;
// How many runs one request can add to or remove from a notebook.
export const NOTEBOOK_RUNS_PER_REQUEST_MAX = 100;

export interface ParsedNotebookLinkUrl {
  /** The URL as the browser would open it, query string and fragment kept. */
  url: string;
  /** Two links with the same key point to the same page. */
  urlKey: string;
}

/**
 * Parses a pasted link. Returns null unless it is an http or https URL with
 * a host and no username or password, at most
 * {@link NOTEBOOK_LINK_URL_MAX_LENGTH} characters long.
 */
export function parseNotebookLinkUrl(
  input: string
): ParsedNotebookLinkUrl | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > NOTEBOOK_LINK_URL_MAX_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.hostname === "") {
    return null;
  }
  return { url: url.href, urlKey: keyForUrl(url) };
}

/** The same-page key for a link, or null when the link isn't allowed. */
export function notebookUrlKey(input: string): string | null {
  return parseNotebookLinkUrl(input)?.urlKey ?? null;
}

const BARE_URL = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/\S*)?$/i;

/**
 * The same-page key for a search query that looks like a URL, with or
 * without its `https://`. Returns null for anything else.
 */
export function notebookSearchKey(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.includes("://")) {
    return notebookUrlKey(trimmed);
  }
  if (BARE_URL.test(trimmed)) {
    return notebookUrlKey(`https://${trimmed}`);
  }
  return null;
}

const NOTION_HOSTS = ["notion.so", "notion.site", "notion.com"];
const TRACKING_PARAM = /^(?:utm_.*|fbclid|gclid)$/i;

function keyForUrl(url: URL): string {
  const host = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (isNotionHost(host)) {
    const pageId = notionPageId(url);
    if (pageId) {
      return `notion:${pageId}`;
    }
  }
  // The URL parser already drops the scheme's own default port; this also
  // drops 80 on https and 443 on http, which point to the same page.
  const port = url.port === "80" || url.port === "443" ? "" : url.port;
  const path = url.pathname.replace(/\/+$/, "");
  const params = [...url.searchParams]
    .filter(([name]) => !TRACKING_PARAM.test(name))
    .sort(([a, aValue], [b, bValue]) =>
      a === b ? compare(aValue, bValue) : compare(a, b)
    );
  const query =
    params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${port ? `:${port}` : ""}${path}${query}`;
}

function compare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function isNotionHost(host: string): boolean {
  return NOTION_HOSTS.some(
    (notionHost) => host === notionHost || host.endsWith(`.${notionHost}`)
  );
}

const NOTION_ID = /(?:^|-)([0-9a-f]{32})$/i;
const NOTION_UUID =
  /(?:^|-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Notion puts the page ID at the end of the last path segment, after the
// page title, so renaming a page changes its URL but not its ID. A page
// opened in side peek keeps the ID in `?p=` instead.
function notionPageId(url: URL): string | null {
  const peek = url.searchParams.get("p");
  if (peek) {
    const id = notionIdIn(peek);
    if (id) {
      return id;
    }
  }
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  return segment ? notionIdIn(safeDecode(segment)) : null;
}

function notionIdIn(text: string): string | null {
  const match = NOTION_ID.exec(text) ?? NOTION_UUID.exec(text);
  return match?.[1] ? match[1].replaceAll("-", "").toLowerCase() : null;
}

// Long hex strings and UUIDs at the end of a segment are page IDs, not
// words. The 16-character minimum keeps short words like "cafe" and dates.
const TRAILING_ID =
  /[-_]?(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ACTION_SEGMENTS = new Set(["edit", "view", "preview"]);

/**
 * A name for a notebook page worked out from its link: the page name taken
 * from the last part of its path, like "Heat stress day 1" for a Notion page
 * titled that, or the site when the path has no name in it. Forms suggest it
 * for a new notebook. Migration `0072_lab_notebooks` named pages that had no
 * label the same way.
 */
export function notebookNameFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);
  while (
    segments.length > 1 &&
    ACTION_SEGMENTS.has((segments.at(-1) ?? "").toLowerCase())
  ) {
    segments.pop();
  }
  const segment = segments.at(-1);
  if (!segment) {
    return host;
  }
  const name = safeDecode(segment)
    .replace(TRAILING_ID, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return name || host;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export const NOTEBOOK_LINK_URL_MESSAGE =
  "Enter a link that starts with http:// or https://.";

/** A pasted link. Parse it with {@link parseNotebookLinkUrl} before saving. */
export const notebookLinkUrlSchema = z
  .string()
  .trim()
  .min(1, "Enter a link.")
  .max(
    NOTEBOOK_LINK_URL_MAX_LENGTH,
    `Links can be at most ${NOTEBOOK_LINK_URL_MAX_LENGTH} characters.`
  )
  .refine((value) => notebookUrlKey(value) !== null, {
    message: NOTEBOOK_LINK_URL_MESSAGE,
  });

/** A notebook's name: required, one line. */
export const notebookNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(
    NOTEBOOK_NAME_MAX_LENGTH,
    `Names can be at most ${NOTEBOOK_NAME_MAX_LENGTH} characters.`
  )
  .refine((value) => !hasControlCharacter(value), {
    message: "Names must be a single line.",
  });

/** A notebook's description as typed. Blank means none. */
export const notebookDescriptionSchema = z
  .string()
  .trim()
  .max(
    NOTEBOOK_DESCRIPTION_MAX_LENGTH,
    `Descriptions can be at most ${NOTEBOOK_DESCRIPTION_MAX_LENGTH} characters.`
  );

/** A blank description means "no description". */
export function blankToNull(value: string): string | null {
  return value === "" ? null : value;
}

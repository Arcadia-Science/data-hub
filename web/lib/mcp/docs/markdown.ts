// Text helpers for the docs bundle: splitting a page into sections, flattening
// Markdown for indexing, and cutting excerpts for search results.

const HEADING = /^(#{2,3})\s+(.+?)\s*$/;
// The docs pin anchors with a trailing `[#id]`; headings without one get the
// slug the docs site generates.
const EXPLICIT_ID = /\s*\[#([^\]\s]+)\]\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

export interface MarkdownSection {
  heading: string;
  id: string;
  level: 2 | 3;
  /** Heading plus everything beneath it, including deeper headings. */
  markdown: string;
  /** Text up to the next heading of any level, so search hits stay specific. */
  text: string;
}

export interface SplitMarkdown {
  /** Text before the first `##` heading, minus the page's `#` title line. */
  intro: string;
  sections: MarkdownSection[];
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "")
    .replace(/ /g, "-");
}

interface HeadingMark {
  heading: string;
  id: string;
  index: number;
  level: 2 | 3;
}

function findHeadings(lines: string[]): HeadingMark[] {
  const headings: HeadingMark[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;

  for (const [index, line] of lines.entries()) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence)) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }

    const match = HEADING.exec(line);
    if (!match) {
      continue;
    }
    const explicit = EXPLICIT_ID.exec(match[2] ?? "")?.[1];
    const heading = (match[2] ?? "").replace(EXPLICIT_ID, "").trim();
    const base = explicit ?? slugifyHeading(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({
      heading,
      id: count === 0 ? base : `${base}-${count}`,
      index,
      level: match[1]?.length === 2 ? 2 : 3,
    });
  }
  return headings;
}

export function splitSections(markdown: string): SplitMarkdown {
  const lines = markdown.split("\n");
  const headings = findHeadings(lines);

  const first = headings[0]?.index ?? lines.length;
  const intro = lines
    .slice(0, first)
    .filter((line, index) => !(index === 0 && line.startsWith("# ")))
    .join("\n")
    .trim();

  const sections = headings.map((mark, position): MarkdownSection => {
    const next = headings[position + 1];
    const end = headings
      .slice(position + 1)
      .find((later) => later.level <= mark.level);
    return {
      id: mark.id,
      heading: mark.heading,
      level: mark.level,
      text: lines
        .slice(mark.index + 1, next?.index ?? lines.length)
        .join("\n")
        .trim(),
      markdown: lines
        .slice(mark.index, end?.index ?? lines.length)
        .join("\n")
        .trim(),
    };
  });

  return { intro, sections };
}

const JSX_TAG = /<\/?[A-Z][A-Za-z]*(?:\s[^>]*?)?\/?>/g;
const JSX_TEXT_ATTRIBUTE = /\b(?:title|description)="([^"]*)"/g;

/**
 * Flattens Markdown to plain sentences for indexing and excerpts. Component
 * tags such as `<Card title="…" description="…" />` carry real wording in
 * their attributes, so those survive while the tags themselves go.
 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(JSX_TAG, (tag) => {
      const phrases = [...tag.matchAll(JSX_TEXT_ATTRIBUTE)]
        .map((match) => match[1] ?? "")
        .filter(Boolean)
        .map((phrase) => (/[.!?]$/.test(phrase) ? phrase : `${phrase}.`));
      return phrases.length > 0 ? ` ${phrases.join(" ")} ` : " ";
    })
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(EXPLICIT_ID, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[`*]/g, "")
    .replace(/[|>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A short passage around the first place a search term appears, trimmed to
 * word boundaries. Falls back to the start of the text when nothing matches,
 * for example when only the page title matched.
 */
export function makeExcerpt(
  plainText: string,
  terms: readonly string[],
  maxLength = 300
): string {
  if (plainText.length <= maxLength) {
    return plainText;
  }

  const lower = plainText.toLowerCase();
  const hits = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((position) => position >= 0);
  const anchor = hits.length > 0 ? Math.min(...hits) : 0;

  let start = Math.max(0, anchor - 80);
  if (start > 0) {
    const boundary = plainText.indexOf(" ", start);
    start = boundary === -1 ? start : boundary + 1;
  }
  let end = Math.min(plainText.length, start + maxLength);
  if (end < plainText.length) {
    const boundary = plainText.lastIndexOf(" ", end);
    end = boundary > start ? boundary : end;
  }

  return `${start > 0 ? "…" : ""}${plainText.slice(start, end).trim()}${
    end < plainText.length ? "…" : ""
  }`;
}

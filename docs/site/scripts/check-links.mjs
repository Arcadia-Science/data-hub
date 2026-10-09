// Checks the docs links that cross folder boundaries, which no single build
// would notice when a page or file moves. Run it with `npm run check:links`
// (or `make docs-links`). It checks that the target page or file exists. It
// does not check `#heading` anchors.
//
//   1. Page names in `web/lib/docs.ts` (`${DOCS_URL}/<page>`).
//   2. `docs:` links in `web/content/changelog/*.md` frontmatter.
//   3. GitHub links from the docs site to files in this repository, such as
//      `.../blob/production/docs/developer/lambda.md`.
//   4. Relative links inside `docs/developer/*.md`.
//
// Plain Node, no dependencies.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const REPO_ROOT = path.resolve(SITE_DIR, "..", "..");
const PAGES_DIR = path.join(SITE_DIR, "content", "docs");
const DEV_DOCS_DIR = path.join(REPO_ROOT, "docs", "developer");
const WEB_DOCS_FILE = path.join(REPO_ROOT, "web", "lib", "docs.ts");
const CHANGELOG_DIR = path.join(REPO_ROOT, "web", "content", "changelog");

// The site goes live from the `production` branch, so links into the repository
// must use it. Other branches would describe code that is not live yet.
const LIVE_REF = "production";
const NON_LIVE_REFS = new Set(["staging", "main"]);

// `/docs/api/...` pages are generated from the OpenAPI snapshot, and these
// routes are not MDX pages.
const GENERATED_PAGE_PREFIX = "api";
const NON_PAGE_ROUTES = new Set(["llms.txt", "llms-full.txt", "sitemap.xml"]);

const DOCS_URL_IN_CODE = /\$\{DOCS_URL\}(\/[^`"'\s]*)/g;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONTMATTER_DOCS_LINE = /^docs:\s*["']?([^"'\s]+)["']?\s*$/m;
const SITE_DOCS_URL =
  /^(?:https?:\/\/datahub\.arcadiascience\.com)?\/docs(\/[^?#]*)?(?:[?#].*)?$/;
const REPO_FILE_LINK =
  /https:\/\/github\.com\/Arcadia-Science\/data-hub\/(?:blob|tree)\/([^/\s)"'`>]+)\/([^\s)"'`>#?]*)/g;
const MARKDOWN_LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const FENCED_CODE_BLOCK = /^(```|~~~)[\s\S]*?^\1/gm;
const INLINE_CODE = /`[^`\n]*`/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const QUERY_OR_HASH = /[?#]/;
const NON_NEWLINE = /[^\n]/g;
const LEADING_SLASHES = /^\/+/;
const TRAILING_SLASHES = /\/+$/;
const MD_SUFFIX = /\.md$/;

const problems = [];
const counts = {
  pageNames: 0,
  changelogLinks: 0,
  repoFileLinks: 0,
  developerDocLinks: 0,
};

function relativeToRepo(file) {
  return path.relative(REPO_ROOT, file);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function report(file, text, index, message) {
  problems.push(`${relativeToRepo(file)}:${lineOf(text, index)}: ${message}`);
}

function listFiles(dir, extension) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(full, extension));
    } else if (entry.name.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pageExists(slug) {
  if (slug === "" || NON_PAGE_ROUTES.has(slug)) {
    return true;
  }
  if (
    slug === GENERATED_PAGE_PREFIX ||
    slug.startsWith(`${GENERATED_PAGE_PREFIX}/`)
  ) {
    return true;
  }
  return (
    existsSync(path.join(PAGES_DIR, `${slug}.mdx`)) ||
    existsSync(path.join(PAGES_DIR, slug, "index.mdx"))
  );
}

// Turns "/overview", "/overview/", or "/overview.md" into "overview".
function toSlug(pathAfterDocs) {
  return safeDecode(pathAfterDocs ?? "")
    .replace(TRAILING_SLASHES, "")
    .replace(LEADING_SLASHES, "")
    .replace(MD_SUFFIX, "");
}

function checkWebDocsFile() {
  const text = readFileSync(WEB_DOCS_FILE, "utf8");
  for (const match of text.matchAll(DOCS_URL_IN_CODE)) {
    counts.pageNames += 1;
    const slug = toSlug(match[1].split(QUERY_OR_HASH)[0]);
    if (!pageExists(slug)) {
      report(
        WEB_DOCS_FILE,
        text,
        match.index,
        `docs page "${slug}" does not exist in docs/site/content/docs`
      );
    }
  }
}

function checkChangelogLinks() {
  for (const file of listFiles(CHANGELOG_DIR, ".md")) {
    const text = readFileSync(file, "utf8");
    const frontmatter = text.match(FRONTMATTER)?.[1];
    const docsUrl = frontmatter?.match(FRONTMATTER_DOCS_LINE)?.[1];
    if (!docsUrl) {
      continue;
    }

    const site = docsUrl.match(SITE_DOCS_URL);
    if (!site) {
      // Not a link to this docs site (for example, an external page).
      continue;
    }

    counts.changelogLinks += 1;
    const slug = toSlug(site[1]);
    if (!pageExists(slug)) {
      report(
        file,
        text,
        text.indexOf(docsUrl),
        `docs page "${slug}" does not exist in docs/site/content/docs`
      );
    }
  }
}

function checkRepoFileLinks() {
  for (const file of listFiles(PAGES_DIR, ".mdx")) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(REPO_FILE_LINK)) {
      counts.repoFileLinks += 1;
      const [, ref, linkedPath] = match;
      if (NON_LIVE_REFS.has(ref)) {
        report(
          file,
          text,
          match.index,
          `link uses the "${ref}" branch; use "${LIVE_REF}" so it matches the live code`
        );
      }

      const target = path.join(
        REPO_ROOT,
        safeDecode(linkedPath).replace(TRAILING_SLASHES, "")
      );
      if (!existsSync(target)) {
        report(
          file,
          text,
          match.index,
          `"${linkedPath}" does not exist in this repository`
        );
      }
    }
  }
}

// Blank out code so example links inside it are not checked. Newlines stay, so
// line numbers still match the original file.
function withoutCode(text) {
  return text
    .replace(FENCED_CODE_BLOCK, (block) => block.replace(NON_NEWLINE, ""))
    .replace(INLINE_CODE, (span) => " ".repeat(span.length));
}

function checkDeveloperDocLinks() {
  for (const file of listFiles(DEV_DOCS_DIR, ".md")) {
    const text = readFileSync(file, "utf8");
    for (const match of withoutCode(text).matchAll(MARKDOWN_LINK_TARGET)) {
      const link = match[1];
      if (link.startsWith("#") || URL_SCHEME.test(link)) {
        continue;
      }

      counts.developerDocLinks += 1;
      const linkedPath = safeDecode(link.split(QUERY_OR_HASH)[0]);
      const base = linkedPath.startsWith("/") ? REPO_ROOT : path.dirname(file);
      if (!existsSync(path.join(base, linkedPath))) {
        report(file, text, match.index, `"${link}" does not exist`);
      }
    }
  }
}

checkWebDocsFile();
checkChangelogLinks();
checkRepoFileLinks();
checkDeveloperDocLinks();

// A count of zero means a pattern above stopped matching (for example, after
// a rename), so the check would silently pass without checking anything.
for (const [name, count] of Object.entries(counts)) {
  if (count === 0) {
    problems.push(
      `scripts/check-links.mjs: found no "${name}" to check. Update the check if the links moved.`
    );
  }
}

console.log(
  `Checked ${counts.pageNames} page names in web/lib/docs.ts, ${counts.changelogLinks} changelog docs links, ${counts.repoFileLinks} site links to repository files, and ${counts.developerDocLinks} relative links in docs/developer.`
);

if (problems.length > 0) {
  console.error(`\n${problems.length} broken link(s):`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

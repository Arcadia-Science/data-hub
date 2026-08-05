// Empty keeps docs links same-origin, where Microfrontends routes `/docs` to
// the docs app. Set it where nothing proxies `/docs` (local dev, self-hosted).
// Render with `DocsLink` so docs always open in a new tab.
const DOCS_ORIGIN = process.env.NEXT_PUBLIC_DOCS_BASE_URL ?? "";

export const DOCS_URL = `${DOCS_ORIGIN}/docs`;
// Slugs must match data-hub-docs `content/docs/*.mdx` (and meta.json).
export const QUICKSTART_DOCS_URL = `${DOCS_URL}/overview`;
export const ADD_INSTRUMENT_DOCS_URL = `${DOCS_URL}/set-up-an-instrument`;
export const MANAGING_TOKENS_DOCS_URL = `${DOCS_URL}/manage-tokens`;

// Must be `NEXT_PUBLIC_` so it inlines into the client bundle: some docs links
// render in Client Components (e.g. the sidebar user menu), where a bare
// `process.env` var would be `undefined`.
const DOCS_ORIGIN =
  process.env.NEXT_PUBLIC_DOCS_BASE_URL ?? "https://datahub.arcadiascience.com";

// The docs site is served under `/docs` on the product's domain (Vercel
// Microfrontends), so every docs link hangs off `${DOCS_ORIGIN}/docs`.
export const DOCS_URL = `${DOCS_ORIGIN}/docs`;
export const QUICKSTART_DOCS_URL = `${DOCS_URL}/quickstart`;
export const ADD_INSTRUMENT_DOCS_URL = `${DOCS_URL}/adding-an-instrument`;
export const MANAGING_TOKENS_DOCS_URL = `${DOCS_URL}/managing-tokens`;

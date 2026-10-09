import { fileURLToPath } from "node:url";
import { withMicrofrontends } from "@vercel/microfrontends/next/config";
import { createMDX } from "fumadocs-mdx/next";

// The web app owns the one microfrontends config (it is the default app), and
// this app reads that same file instead of keeping a copy. Both local runs and
// Vercel builds need `docs/site/../../web` to exist, which means Vercel's
// "Include source files outside of the Root Directory" setting must stay on.
// A value already set in the environment wins, so the path can be overridden.
process.env.VC_MICROFRONTENDS_CONFIG ??= fileURLToPath(
  new URL("../../web/microfrontends.json", import.meta.url)
);

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
};

export default withMicrofrontends(withMDX(config));

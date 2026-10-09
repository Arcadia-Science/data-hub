// Node loader hook for `generate-docs-bundle.ts`. The site's MDX options turn
// local images into static imports, which Node cannot load. The Markdown
// export only needs the original `![alt](path)` text, so image modules can be
// empty.
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

export function load(url, context, nextLoad) {
  if (url.startsWith("file:") && IMAGE_FILE.test(new URL(url).pathname)) {
    return {
      format: "module",
      shortCircuit: true,
      source: "export default { src: '', width: 0, height: 0 };",
    };
  }
  return nextLoad(url, context);
}

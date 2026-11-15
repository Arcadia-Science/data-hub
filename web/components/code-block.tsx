import { codeToHtml } from "shiki";

interface CodeBlockProps {
  className?: string;
  code: string;
  lang: string;
}

/**
 * Syntax-highlighted HTML for `code`, in the colors every code block uses.
 * It runs on the server; pass the result to a client component as a string.
 */
export function highlightCode(code: string, lang: string): Promise<string> {
  return codeToHtml(code, {
    lang,
    themes: {
      light: "github-light-default",
      dark: "github-dark-default",
    },
    defaultColor: false,
  });
}

export async function CodeBlock({ code, lang, className }: CodeBlockProps) {
  const html = await highlightCode(code, lang);

  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki emits syntax-highlighting markup, not raw user HTML
    <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

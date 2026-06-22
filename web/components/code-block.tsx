import { codeToHtml } from "shiki";

interface CodeBlockProps {
  className?: string;
  code: string;
  lang: string;
}

export async function CodeBlock({ code, lang, className }: CodeBlockProps) {
  const html = await codeToHtml(code, {
    lang,
    themes: {
      light: "github-light-default",
      dark: "github-dark-default",
    },
    defaultColor: false,
  });

  return (
    <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

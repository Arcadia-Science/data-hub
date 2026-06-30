"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Restricted set of allowed elements + custom components, keyed to our
// design tokens. We deliberately avoid `rehype-raw` so embedded HTML in the
// markdown source is rendered as text (react-markdown's default in v9+),
// neutralising the XSS surface.
//
// This component is dynamically imported by `RunCommentItem` so the
// react-markdown bundle (~30 KB) only ships when there's a comment to render.
export function CommentMarkdown({ body }: { body: string }) {
  return (
    <div className="break-words text-foreground text-sm leading-relaxed">
      <ReactMarkdown
        components={{
          p: (props) => <p className="mb-2 last:mb-0" {...props} />,
          a: (props) => (
            <a
              {...props}
              className="text-primary underline underline-offset-2 hover:no-underline"
              rel="noopener noreferrer"
              target="_blank"
            />
          ),
          ul: (props) => (
            <ul className="mb-2 ml-5 list-disc last:mb-0" {...props} />
          ),
          ol: (props) => (
            <ol className="mb-2 ml-5 list-decimal last:mb-0" {...props} />
          ),
          li: (props) => <li className="mb-0.5" {...props} />,
          code: ({ className, children, ...props }) => {
            const isBlock = (className ?? "").includes("language-");
            if (isBlock) {
              return (
                <code
                  className="block rounded-md bg-muted px-3 py-2 font-mono text-xs"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-muted px-1 py-0.5 font-mono text-xs"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: (props) => (
            <pre
              className="mb-2 overflow-x-auto rounded-md bg-muted p-3 last:mb-0"
              {...props}
            />
          ),
          blockquote: (props) => (
            <blockquote
              className="mb-2 border-border border-l-2 pl-3 text-muted-foreground italic last:mb-0"
              {...props}
            />
          ),
          h1: (props) => (
            <h1 className="mb-2 font-semibold text-lg" {...props} />
          ),
          h2: (props) => (
            <h2 className="mb-2 font-semibold text-base" {...props} />
          ),
          h3: (props) => (
            <h3 className="mb-1 font-semibold text-sm" {...props} />
          ),
          hr: () => <hr className="my-3 border-border" />,
          table: (props) => (
            <div className="mb-2 overflow-x-auto last:mb-0">
              <table className="w-full text-xs" {...props} />
            </div>
          ),
          th: (props) => (
            <th
              className="border-border border-b px-2 py-1 text-left font-medium"
              {...props}
            />
          ),
          td: (props) => (
            <td className="border-border/50 border-b px-2 py-1" {...props} />
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

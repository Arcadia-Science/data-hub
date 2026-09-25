import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// No `rehype-raw`, so embedded HTML stays text. Headings render as paragraphs
// so a comment can't add an `<h1>` under the page heading. `RunCommentItem`
// loads this lazily (~30 KB).

type MarkdownProps = ComponentPropsWithoutRef<"p">;

function textBlock(className: string) {
  return ({ node: _node, ...props }: MarkdownProps & { node?: unknown }) => (
    <p className={className} {...props} />
  );
}

const blockComponents = {
  p: textBlock("mb-2 last:mb-0"),
  ul: (props: ComponentPropsWithoutRef<"ul">) => (
    <ul className="mb-2 ml-5 list-disc last:mb-0" {...props} />
  ),
  ol: (props: ComponentPropsWithoutRef<"ol">) => (
    <ol className="mb-2 ml-5 list-decimal last:mb-0" {...props} />
  ),
  li: (props: ComponentPropsWithoutRef<"li">) => (
    <li className="mb-0.5" {...props} />
  ),
  code: ({
    className,
    children,
    node: _node,
    ...props
  }: ComponentPropsWithoutRef<"code"> & { node?: unknown }) => {
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
  pre: (props: ComponentPropsWithoutRef<"pre">) => (
    <pre
      className="mb-2 overflow-x-auto rounded-md bg-muted p-3 last:mb-0"
      {...props}
    />
  ),
  blockquote: (props: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className="mb-2 border-border border-l-2 pl-3 text-muted-foreground italic last:mb-0"
      {...props}
    />
  ),
  h1: textBlock("mb-2 font-semibold text-lg"),
  h2: textBlock("mb-2 font-semibold text-base"),
  h3: textBlock("mb-1 font-semibold text-sm"),
  hr: () => <hr className="my-3 border-border" />,
  table: (props: ComponentPropsWithoutRef<"table">) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full text-xs" {...props} />
    </div>
  ),
  th: (props: ComponentPropsWithoutRef<"th">) => (
    <th
      className="border-border border-b px-2 py-1 text-left font-medium"
      {...props}
    />
  ),
  td: (props: ComponentPropsWithoutRef<"td">) => (
    <td className="border-border/50 border-b px-2 py-1" {...props} />
  ),
} satisfies Partial<Components>;

function MarkdownBody({
  body,
  components,
}: {
  body: string;
  components: Partial<Components>;
}) {
  return (
    <div className="break-words text-foreground text-sm leading-relaxed">
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

export function CommentMarkdown({ body }: { body: string }) {
  return (
    <MarkdownBody
      body={body}
      components={{
        ...blockComponents,
        a: ({ node: _node, ...props }) => (
          <a
            {...props}
            className="relative z-10 text-primary underline underline-offset-2 hover:no-underline"
            rel="noopener noreferrer"
            target="_blank"
          />
        ),
      }}
    />
  );
}

// Card previews clip to a few lines, so links below the clip would still be
// tabbable. Render them as text; the card itself is the link.
export function CommentMarkdownPreview({ body }: { body: string }) {
  return (
    <MarkdownBody
      body={body}
      components={{
        ...blockComponents,
        a: ({ children }) => (
          <span className="text-primary underline underline-offset-2">
            {children}
          </span>
        ),
      }}
    />
  );
}

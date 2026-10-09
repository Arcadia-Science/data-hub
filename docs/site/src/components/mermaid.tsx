"use client";

import type { MermaidConfig } from "mermaid";
import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState } from "react";

export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      const config: MermaidConfig = {
        startOnLoad: false,
        securityLevel: "loose",
        fontFamily: "inherit",
        themeCSS: "margin: 1.5rem auto 0;",
        theme: resolvedTheme === "dark" ? "dark" : "default",
      };

      const { default: mermaid } = await import("mermaid");

      try {
        mermaid.initialize(config);
        const { svg: rendered } = await mermaid.render(
          // `useId` returns a value containing ":" which is invalid in an id attribute.
          id.replaceAll(":", ""),
          chart.replaceAll("\\n", "\n"),
          containerRef.current ?? undefined
        );
        if (!cancelled) {
          setSvg(rendered);
        }
      } catch (error) {
        // Surface render failures in the console rather than crashing the page.
        console.error("Failed to render mermaid diagram", error);
      }
    }

    renderChart();

    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  return (
    <div
      className="not-prose flex justify-center"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid returns trusted, self-generated SVG markup.
      dangerouslySetInnerHTML={{ __html: svg }}
      ref={containerRef}
    />
  );
}

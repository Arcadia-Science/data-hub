import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useDocumentTheme } from "@modelcontextprotocol/ext-apps/react";
import { useEffect } from "react";

export type HostContainerDimensions = NonNullable<
  McpUiHostContext["containerDimensions"]
>;

export interface DocumentSizeStyles {
  height: string;
  maxHeight: string;
  maxWidth: string;
  minHeight: string;
  overflow: string;
  width: string;
}

const EMPTY_SIZE_STYLES: DocumentSizeStyles = {
  height: "",
  maxHeight: "",
  minHeight: "",
  overflow: "",
  width: "",
  maxWidth: "",
};

// The spec's View Behavior snippet sets height/maxHeight/width/maxWidth on
// `document.documentElement`. Overflow is not in that snippet, but without it
// a capped View paints past the box and the host iframe clips the rest.
export function documentStylesForContainerDimensions(
  dimensions: HostContainerDimensions | undefined
): DocumentSizeStyles {
  const styles: DocumentSizeStyles = { ...EMPTY_SIZE_STYLES };
  if (!dimensions) {
    return styles;
  }

  if ("height" in dimensions && typeof dimensions.height === "number") {
    styles.height = "100vh";
    styles.minHeight = "100%";
    styles.overflow = "auto";
  } else if (
    "maxHeight" in dimensions &&
    typeof dimensions.maxHeight === "number" &&
    dimensions.maxHeight > 0
  ) {
    styles.maxHeight = `${dimensions.maxHeight}px`;
    styles.overflow = "auto";
  }

  if ("width" in dimensions && typeof dimensions.width === "number") {
    // Fill the host-controlled iframe. `100vw` includes the scrollbar gutter
    // and can start a horizontal overflow loop with `overflow: auto`.
    styles.width = "100%";
  } else if (
    "maxWidth" in dimensions &&
    typeof dimensions.maxWidth === "number" &&
    dimensions.maxWidth > 0
  ) {
    styles.maxWidth = `${dimensions.maxWidth}px`;
  }

  return styles;
}

function sizeStylesEqual(
  left: DocumentSizeStyles,
  right: DocumentSizeStyles
): boolean {
  return (
    left.height === right.height &&
    left.maxHeight === right.maxHeight &&
    left.minHeight === right.minHeight &&
    left.overflow === right.overflow &&
    left.width === right.width &&
    left.maxWidth === right.maxWidth
  );
}

function readSizeStyles(target: CSSStyleDeclaration): DocumentSizeStyles {
  return {
    height: target.height,
    maxHeight: target.maxHeight,
    minHeight: target.minHeight,
    overflow: target.overflow,
    width: target.width,
    maxWidth: target.maxWidth,
  };
}

function writeSizeStyles(
  target: CSSStyleDeclaration,
  styles: DocumentSizeStyles
): void {
  target.height = styles.height;
  target.maxHeight = styles.maxHeight;
  target.minHeight = styles.minHeight;
  target.overflow = styles.overflow;
  target.width = styles.width;
  target.maxWidth = styles.maxWidth;
}

export function applyContainerDimensions(
  dimensions: HostContainerDimensions | undefined,
  target: CSSStyleDeclaration = document.documentElement.style
): void {
  const next = documentStylesForContainerDimensions(dimensions);
  if (sizeStylesEqual(readSizeStyles(target), next)) {
    return;
  }
  writeSizeStyles(target, next);
}

export function useContainerDimensions(app: App | null): void {
  useEffect(() => {
    if (!app) {
      return;
    }
    const apply = () => {
      applyContainerDimensions(app.getHostContext()?.containerDimensions);
    };
    apply();
    app.addEventListener("hostcontextchanged", apply);
    return () => {
      app.removeEventListener("hostcontextchanged", apply);
    };
  }, [app]);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function useDarkClass(): void {
  const theme = useDocumentTheme();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
}

// Shared report components use `<a target="_blank">`. The sandbox blocks
// popups, so intercept those clicks and ask the host to open the URL.
export function useOpenLinkInterceptor(app: App | null): void {
  useEffect(() => {
    if (!app) {
      return;
    }

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a");
      if (!anchor) {
        return;
      }
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
        return;
      }
      const opensExternally =
        anchor.target === "_blank" || isHttpUrl(href) || href.startsWith("/");
      if (!opensExternally) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const url = isHttpUrl(href)
        ? href
        : new URL(href, window.location.href).href;

      if (app.getHostCapabilities()?.openLinks) {
        void app.openLink({ url });
        return;
      }
      const fallback = document.getElementById("open-link-fallback");
      if (fallback) {
        fallback.textContent = url;
        fallback.hidden = false;
      }
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [app]);
}

export function persistKey(instrumentId: string, runId: string): string {
  return `data-hub:run-report:${instrumentId}:${runId}`;
}

export function readPersistedFileId(key: string): number | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as { fileId?: number };
    return typeof parsed.fileId === "number" ? parsed.fileId : undefined;
  } catch {
    return;
  }
}

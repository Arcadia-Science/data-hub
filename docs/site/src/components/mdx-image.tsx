import type { ImageProps } from "next/image";
import type { ImgHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { DocsImage, toPixel } from "./docs-image";
import { findScreenshot, Screenshot } from "./screenshot";

const mdxSizes =
  "(max-width: 768px) 100vw, (max-width: 1200px) 70vw, 900px" as const;

function resolveMdxSrc(src: unknown): ImageProps["src"] | undefined {
  if (typeof src === "string" && src.length > 0) {
    return src;
  }
  if (!src || typeof src !== "object" || src instanceof Blob) {
    return;
  }
  if ("default" in src || "src" in src) {
    return src as ImageProps["src"];
  }
  return;
}

type MdxImageProps = ImgHTMLAttributes<HTMLImageElement> &
  Pick<ImageProps, "placeholder">;

// A page references the light file. If it is a generated screenshot, this
// shows the light and dark pair, inside a browser frame for full windows.
// Any other image renders as it always has.
export function MdxImage({
  alt = "",
  className,
  height,
  placeholder,
  sizes,
  src,
  style: _style,
  title,
  width,
}: MdxImageProps) {
  const imageSrc = resolveMdxSrc(src);
  if (!imageSrc) {
    return null;
  }

  const screenshot = findScreenshot(imageSrc);
  if (screenshot) {
    return (
      <Screenshot
        alt={alt}
        className={cn("my-6", className)}
        entry={screenshot}
        sizes={sizes ?? mdxSizes}
      />
    );
  }

  return (
    <DocsImage
      alt={alt}
      className={cn("rounded-lg", className)}
      height={toPixel(height)}
      placeholder={placeholder}
      sizes={sizes ?? mdxSizes}
      src={imageSrc}
      title={title}
      width={toPixel(width)}
    />
  );
}

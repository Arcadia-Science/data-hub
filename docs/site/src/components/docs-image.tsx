import type { ImageProps, StaticImageData } from "next/image";
import Image from "next/image";
import type { ImgHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type DocsImageProps = Omit<ImageProps, "style">;

// Next.js reserves layout from width/height attrs; CSS `height: auto` plus
// `aspect-ratio` is what actually keeps a flex/prose box from collapsing
// before the file decodes. See next/dist/docs Image "responsive".
const responsiveStyle = {
  width: "100%",
  height: "auto",
} as const;

const mdxSizes =
  "(max-width: 768px) 100vw, (max-width: 1200px) 70vw, 900px" as const;

const PIXEL_DIMENSION = /^\d+$/;

function toPixel(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && PIXEL_DIMENSION.test(value)) {
    return Number.parseInt(value, 10);
  }
  return;
}

function getStaticImageData(
  src: ImageProps["src"]
): StaticImageData | undefined {
  if (typeof src === "string") {
    return;
  }
  if ("default" in src) {
    return src.default;
  }
  return src;
}

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

export function DocsImage({
  alt,
  height,
  placeholder,
  sizes,
  src,
  width,
  ...props
}: DocsImageProps) {
  const staticImage = getStaticImageData(src);
  const widthPx = toPixel(width) ?? staticImage?.width;
  const heightPx = toPixel(height) ?? staticImage?.height;

  return (
    <Image
      alt={alt}
      placeholder={placeholder ?? (staticImage ? "blur" : "empty")}
      sizes={sizes}
      src={src}
      {...props}
      height={heightPx}
      style={{
        ...responsiveStyle,
        ...(widthPx && heightPx
          ? { aspectRatio: `${widthPx} / ${heightPx}` }
          : {}),
      }}
      width={widthPx}
    />
  );
}

type MdxImageProps = ImgHTMLAttributes<HTMLImageElement> &
  Pick<ImageProps, "placeholder">;

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

import type { ImageProps, StaticImageData } from "next/image";
import Image from "next/image";

type DocsImageProps = Omit<ImageProps, "style">;

// Next.js reserves layout from width/height attrs; CSS `height: auto` plus
// `aspect-ratio` is what actually keeps a flex/prose box from collapsing
// before the file decodes. See next/dist/docs Image "responsive".
const responsiveStyle = {
  width: "100%",
  height: "auto",
} as const;

const PIXEL_DIMENSION = /^\d+$/;

export function toPixel(value: unknown): number | undefined {
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

import { TriangleAlert } from "lucide-react";

/** Kept in sync with the banner's `h-8` class; layout/sidebar subtract this. */
export const PREVIEW_BANNER_HEIGHT = "2rem";

// `fixed` rather than in-flow so it paints above the viewport-fixed sidebar
// (`z-10`); `RootLayout` reserves space via `--banner-height` so nothing hides
// under it. `VERCEL_*` are unset off Vercel, so this only renders on previews.
export function PreviewDeploymentBanner() {
  if (process.env.VERCEL_ENV !== "preview") {
    return null;
  }

  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex h-8 items-center justify-center gap-2 overflow-hidden bg-amber-500 px-4 text-center font-medium text-amber-950 text-sm dark:bg-amber-400"
      role="alert"
    >
      <TriangleAlert className="size-4 shrink-0" />
      <span className="truncate">
        This is a preview deployment
        {branch ? ` for the ${branch} branch` : ""}.
      </span>
      {productionUrl ? (
        <a
          className="shrink-0 underline underline-offset-2 hover:no-underline"
          href={`https://${productionUrl}`}
        >
          Go to production
        </a>
      ) : null}
    </div>
  );
}

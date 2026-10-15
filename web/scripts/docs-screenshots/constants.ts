import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");

// Better Auth drops the `__Secure-` prefix on an `http://` origin.
export const SESSION_COOKIE_NAME = "better-auth.session_token";

export const IMAGES_DIR = path.join(
  REPO_DIR,
  "docs",
  "site",
  "public",
  "images"
);
export const MANIFEST_FILE = path.join(
  REPO_DIR,
  "docs",
  "site",
  "src",
  "lib",
  "screenshots.generated.ts"
);

// Matches the docs home page's code sample, which uses the same placeholder
// host for a deployment.
export const PLACEHOLDER_HOST = "datahub.example.com";

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;
// Twice the pixels keeps text sharp on high-density screens.
export const DEVICE_SCALE_FACTOR = 2;
export const WEBP_QUALITY = 82;

import { headers } from "next/headers";
import { REQUEST_PATH_HEADER, safeCallbackPath } from "@/lib/callback-url";

/**
 * Path and query of the current page request, as recorded by `proxy.ts`.
 * Returns `/` when the header is missing.
 */
export async function getRequestPath(): Promise<string> {
  return safeCallbackPath((await headers()).get(REQUEST_PATH_HEADER));
}

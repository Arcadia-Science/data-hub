import { headers } from "next/headers";
import { REQUEST_PATH_HEADER, safeCallbackPath } from "@/lib/callback-url";

/**
 * Path and query of the current request, as recorded by `proxy.ts`. Falls back
 * to `fallback` when the proxy didn't run for this render.
 */
export async function getRequestPath(fallback: string): Promise<string> {
  const value = (await headers()).get(REQUEST_PATH_HEADER);
  return safeCallbackPath(value ?? fallback);
}

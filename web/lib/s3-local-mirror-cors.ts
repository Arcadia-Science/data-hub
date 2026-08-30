// Same `*` GET CORS the real buckets declare in `infra/template.yaml`.
// The MCP Apps View `fetch`es CSV and JSON from `/api/local-s3` inside a
// host-chosen sandbox origin, so the origin cannot be allowlisted.

export const LOCAL_S3_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers":
    "ETag, Content-Length, Content-Range, Accept-Ranges",
  "Access-Control-Max-Age": "3600",
};

export function localS3CorsPreflight(): Response {
  return new Response(null, { status: 204, headers: LOCAL_S3_CORS_HEADERS });
}

export function withLocalS3Cors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(LOCAL_S3_CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

import { buildOpenApiDocument } from "@/lib/api/openapi";

export function GET() {
  return Response.json(buildOpenApiDocument(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}

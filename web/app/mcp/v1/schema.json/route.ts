import { buildMcpCatalogDocument } from "@/lib/mcp/catalog";

// Schema is pure (no DB/env); bake it into the build so every deploy
// serves a fixed document without recomputing on each request.
export const dynamic = "force-static";

export function GET() {
  return Response.json(buildMcpCatalogDocument(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}

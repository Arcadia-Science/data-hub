import { z } from "zod";
import {
  archiveJobIdParam,
  bearerSecurity,
  errorResponses,
  jsonResponse,
  registry,
} from "../registry";
import { patchArchiveJobBody } from "../schemas/archive";

registry.registerPath({
  method: "patch",
  path: "/archive-jobs/{id}",
  operationId: "updateArchiveJob",
  summary: "Update an archive job",
  description: "Requires scope `archive-jobs:write`.",
  tags: ["Archive"],
  security: bearerSecurity,
  request: {
    params: z.object({ id: archiveJobIdParam }),
    body: { content: { "application/json": { schema: patchArchiveJobBody } } },
  },
  responses: {
    200: jsonResponse("Updated archive job.", z.unknown()),
    ...errorResponses(),
  },
});

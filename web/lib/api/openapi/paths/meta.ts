import { z } from "zod";
import { jsonResponse, registry } from "../registry";

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  operationId: "getOpenApiDocument",
  summary: "Get the OpenAPI document",
  tags: ["Meta"],
  security: [],
  responses: { 200: jsonResponse("OpenAPI 3.1 document.", z.unknown()) },
});

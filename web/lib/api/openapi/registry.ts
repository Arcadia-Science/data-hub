import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  type ResponseConfig,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description:
    "Personal access tokens begin with `dhub_…` and are restricted by their assigned scopes.",
});

export const ErrorBody = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi("ErrorResponse");

registry.register("ErrorResponse", ErrorBody);

export const instrumentIdParam = z
  .string()
  .openapi({ example: "plate-reader" });
export const runIdParam = z.string().openapi({ example: "run-2026-001" });
export const watcherIdParam = z.string().uuid();
export const fileIdParam = z.coerce.number().int();
export const commentIdParam = z.coerce.number().int();
export const archiveJobIdParam = z.string().uuid();

export function jsonResponse(
  description: string,
  schema: z.ZodType,
  status?: number
): ResponseConfig {
  return {
    description,
    ...(status ? { status } : {}),
    content: { "application/json": { schema } },
  };
}

export function errorResponses(): Record<
  401 | 403 | 404 | 400 | 409,
  ResponseConfig
> {
  return {
    400: jsonResponse("Invalid request.", ErrorBody),
    401: jsonResponse("Authentication is required.", ErrorBody),
    403: jsonResponse("The token does not have the required scope.", ErrorBody),
    404: jsonResponse("The requested resource was not found.", ErrorBody),
    409: jsonResponse("The request conflicts with resource state.", ErrorBody),
  };
}

export const bearerSecurity = [{ bearerAuth: [] as string[] }];

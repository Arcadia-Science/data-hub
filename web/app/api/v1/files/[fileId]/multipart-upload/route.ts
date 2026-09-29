import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import {
  cancelMultipartUpload,
  loadMultipartFile,
} from "@/lib/api/multipart-upload";
import { multipartAbortBody, readJsonBody } from "@/lib/api/openapi";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorizeToken(request, "runs:upload");
  if (authResult instanceof Response) {
    return authResult;
  }

  const fileId = Number.parseInt((await params).fileId, 10);
  if (Number.isNaN(fileId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const body = await readJsonBody(request, multipartAbortBody);
  if (body instanceof Response) {
    return body;
  }

  const file = await loadMultipartFile(fileId);
  if (file instanceof Response) {
    return file;
  }

  return await cancelMultipartUpload(file, body.upload_id);
}

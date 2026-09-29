import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import {
  finishMultipartUpload,
  loadMultipartFile,
} from "@/lib/api/multipart-upload";
import { multipartCompleteBody, readJsonBody } from "@/lib/api/openapi";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// S3 can take several minutes to assemble the parts, and it keeps the
// connection open while it does.
export const maxDuration = 300;

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorizeToken(request, "runs:upload");
  if (authResult instanceof Response) {
    return authResult;
  }

  const fileId = Number.parseInt((await params).fileId, 10);
  if (Number.isNaN(fileId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const body = await readJsonBody(request, multipartCompleteBody);
  if (body instanceof Response) {
    return body;
  }

  const file = await loadMultipartFile(fileId);
  if (file instanceof Response) {
    return file;
  }

  return await finishMultipartUpload(
    file,
    body.upload_id,
    body.parts.map((part) => ({
      partNumber: part.part_number,
      etag: part.etag,
    })),
    body.checksum_crc64nvme
  );
}

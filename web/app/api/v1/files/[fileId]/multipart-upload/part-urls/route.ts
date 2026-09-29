import type { NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import { loadMultipartFile, signPartUrls } from "@/lib/api/multipart-upload";
import { multipartPartUrlsBody, readJsonBody } from "@/lib/api/openapi";
import { PART_URL_EXPIRY_SECONDS } from "@/lib/multipart";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorizeToken(request, "runs:upload");
  if (authResult instanceof Response) {
    return authResult;
  }

  const fileId = Number.parseInt((await params).fileId, 10);
  if (Number.isNaN(fileId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const body = await readJsonBody(request, multipartPartUrlsBody);
  if (body instanceof Response) {
    return body;
  }

  const file = await loadMultipartFile(fileId);
  if (file instanceof Response) {
    return file;
  }

  const signed = await signPartUrls(file, body.upload_id, body.part_numbers);
  if (signed instanceof Response) {
    return signed;
  }

  return Response.json({
    expires_in: PART_URL_EXPIRY_SECONDS,
    parts: signed.map((part) => ({
      part_number: part.partNumber,
      upload_url: part.uploadUrl,
    })),
  });
}

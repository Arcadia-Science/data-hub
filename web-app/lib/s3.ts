import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import type { Readable } from "node:stream";

const DEFAULT_DOWNLOAD_EXPIRY_SECONDS = 15 * 60; // 15 minutes
const DEFAULT_UPLOAD_EXPIRY_SECONDS = 60 * 60; // 1 hour — generous for large lab files over slow networks

// Singleton client — reused across requests within the same function instance.
// On Vercel, AWS_ROLE_ARN triggers OIDC federation for short-lived credentials.
// Locally / in tests, the SDK falls back to the default credential chain.
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-west-1",
  credentials: process.env.AWS_ROLE_ARN
    ? awsCredentialsProvider({ roleArn: process.env.AWS_ROLE_ARN })
    : undefined,
});

export function getS3RawDataBucket(): string {
  const bucket = process.env.S3_RAW_DATA_BUCKET;
  if (!bucket) {
    throw new Error("S3_RAW_DATA_BUCKET environment variable is not set");
  }
  return bucket;
}

// Archives bucket holds run-zip artifacts built by the Lambda. The web app
// reads (HEAD + presign) but never writes — Lambda is the only writer.
export function getS3ArchivesBucket(): string {
  const bucket = process.env.S3_ARCHIVES_BUCKET;
  if (!bucket) {
    throw new Error("S3_ARCHIVES_BUCKET environment variable is not set");
  }
  return bucket;
}

export type S3HeadResult =
  | { exists: true; sizeBytes: number | null }
  | { exists: false };

// HeadObject wrapper that translates a "not in cache" response into a clean
// { exists: false }. Real failures (network, malformed request) propagate so
// the caller can surface a 5xx.
//
// Both 404 and 403 are treated as "not in cache":
//   - 404 is the normal missing-object response when the caller has
//     `s3:ListBucket` on the bucket-level ARN.
//   - 403 is what S3 returns for a missing key when the caller only has
//     `s3:GetObject` on `bucket/*` (S3 deliberately won't reveal key
//     existence without ListBucket). The IAM policy in `infra/template.yaml`
//     grants ListBucket so this shouldn't happen, but treating 403 as a
//     cache miss makes the route resilient to future policy drift.
export async function headS3Object(
  bucket: string,
  key: string
): Promise<S3HeadResult> {
  try {
    const response = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    return {
      exists: true,
      sizeBytes: response.ContentLength ?? null,
    };
  } catch (err) {
    if (err instanceof NotFound) return { exists: false };
    if (err instanceof S3ServiceException) {
      const status = err.$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return { exists: false };
    }
    throw err;
  }
}

export type PresignedDownloadOptions = {
  expiresIn?: number;
  // Override the filename the browser saves the response under. Browsers
  // ignore the `<a download="…">` attribute on cross-origin URLs unless the
  // response carries an explicit `Content-Disposition: attachment` header,
  // so for archive downloads (S3 origin → user) we sign the URL with a
  // `response-content-disposition` query param. S3 echoes that header back
  // on the GET response, and the browser uses it as the saved filename.
  filename?: string;
};

// Sanitize a filename for use inside a `Content-Disposition` header. Strips
// CR/LF (header injection) and quotes (which would terminate the filename
// param early), then trims to a length S3 will accept.
function sanitizeContentDispositionFilename(name: string): string {
  const cleaned = name
    .replaceAll(/[\r\n"\\]/g, "")
    .replaceAll(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return cleaned.slice(0, 200) || "download";
}

export async function getPresignedDownloadUrl(
  bucket: string,
  key: string,
  options: PresignedDownloadOptions | number = {}
): Promise<string> {
  // Backwards-compat: callers that passed a bare `expiresIn` number still work.
  const opts: PresignedDownloadOptions =
    typeof options === "number" ? { expiresIn: options } : options;
  const expiresIn = opts.expiresIn ?? DEFAULT_DOWNLOAD_EXPIRY_SECONDS;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(opts.filename && {
      ResponseContentDisposition: `attachment; filename="${sanitizeContentDispositionFilename(opts.filename)}"`,
    }),
  });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function getS3ObjectStream(
  bucket: string,
  key: string
): Promise<Readable> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3.send(command);
  if (!response.Body) {
    throw new Error(`Empty response body for s3://${bucket}/${key}`);
  }
  return response.Body as Readable;
}

export async function getPresignedUploadUrl(
  bucket: string,
  key: string,
  contentType?: string,
  expiresIn: number = DEFAULT_UPLOAD_EXPIRY_SECONDS
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(contentType && { ContentType: contentType }),
  });
  return getSignedUrl(s3, command, { expiresIn });
}

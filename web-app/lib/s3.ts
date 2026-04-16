import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
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

export async function getPresignedDownloadUrl(
  bucket: string,
  key: string,
  expiresIn: number = DEFAULT_DOWNLOAD_EXPIRY_SECONDS
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
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

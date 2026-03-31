import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DEFAULT_EXPIRY_SECONDS = 15 * 60; // 15 minutes

// Singleton client — reused across Lambda invocations in the same process.
// Falls back to IAM role credentials when env vars are absent (deployed on AWS).
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-west-2",
});

export async function getPresignedDownloadUrl(
  bucket: string,
  key: string,
  expiresIn: number = DEFAULT_EXPIRY_SECONDS
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3, command, { expiresIn });
}

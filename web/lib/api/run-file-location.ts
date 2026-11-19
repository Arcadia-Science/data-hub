import type { fileCategoryEnum } from "@/lib/db/schema";
import { getS3ProcessedBucket, getS3RawDataBucket } from "@/lib/s3";

type FileCategory = (typeof fileCategoryEnum.enumValues)[number];

// Where a run's file lives in S3: `<instrument ID>/<run ID>/<filename>`, in
// the raw bucket for an uploaded file and the processed bucket for an
// artifact the Lambda made. Pass the stored run ID, not one from a URL, which
// can have spaces around it.
export function runFileS3Key(
  instrumentId: string,
  runId: string,
  filename: string
): string {
  return `${instrumentId}/${runId}/${filename}`;
}

// The bucket a file of this category lives in. Throws when its environment
// variable is unset.
export function bucketForCategory(category: FileCategory): string {
  return category === "processed"
    ? getS3ProcessedBucket()
    : getS3RawDataBucket();
}

interface RunFileLocation {
  category: FileCategory;
  expectedBucket: string;
  filename: string;
  instrumentId: string;
  runId: string;
  s3Bucket: string;
  s3Key: string;
}

// Why a caller-supplied S3 location can't be stored on a file of this run, or
// null when it can. Download links are signed for whatever location a row
// holds, so a row that pointed anywhere else would hand out another run's
// object (ENG-2275).
export function runFileLocationError({
  instrumentId,
  runId,
  filename,
  category,
  expectedBucket,
  s3Bucket,
  s3Key,
}: RunFileLocation): string | null {
  // A slash would let the key reach into a deeper folder, which is another
  // run's when run IDs nest (run `a` and run `a/b`).
  if (filename.includes("/")) {
    return "filename must not contain '/'";
  }
  if (s3Bucket !== expectedBucket) {
    return `s3_bucket must be Data Hub's ${category} bucket for a ${category} file`;
  }
  const expectedKey = runFileS3Key(instrumentId, runId, filename);
  if (s3Key !== expectedKey) {
    return `s3_key must be '${expectedKey}'`;
  }
  return null;
}

import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

const DEFAULT_REGION = "us-west-1";

// Resolve credentials the same way `web-app/lib/s3.ts` does: use Vercel
// OIDC federation when AWS_ROLE_ARN is set, otherwise fall back to the
// AWS SDK's default credential chain (env vars, ~/.aws/credentials, SSO).
function resolveCredentials() {
  if (process.env.AWS_ROLE_ARN) {
    return awsCredentialsProvider({ roleArn: process.env.AWS_ROLE_ARN });
  }
  return async () => {
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN && {
          sessionToken: process.env.AWS_SESSION_TOKEN,
        }),
      };
    }
    throw new Error(
      "No AWS credentials available: set AWS_ROLE_ARN (Vercel OIDC) or " +
        "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (local dev)"
    );
  };
}

// Cheap, side-effect-free check used by callers (and the configured-check
// in `archive-builder.ts`) to bail with a 503 before they attempt to sign.
// Local dev where AWS_ROLE_ARN is unset but AWS creds are in the
// environment also satisfies this check.
export function hasInvokeCredentials(): boolean {
  return Boolean(
    process.env.AWS_ROLE_ARN ||
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  );
}

export type SignedLambdaInvokeInit = {
  url: string;
  body: string;
  contentType?: string;
};

// Build a SigV4-signed POST against a Lambda Function URL configured with
// AuthType=AWS_IAM. Returns a `Request` ready to hand to `fetch()`.
//
// The Function URL host (e.g. `<id>.lambda-url.us-west-1.on.aws`) encodes
// the region; we use AWS_REGION when set so local dev pointed at staging
// signs correctly even if the URL parsing falls back.
export async function signLambdaInvoke({
  url,
  body,
  contentType = "application/json",
}: SignedLambdaInvokeInit): Promise<Request> {
  const parsed = new URL(url);
  const region =
    process.env.AWS_REGION ?? regionFromHost(parsed.host) ?? DEFAULT_REGION;

  const credentials = await resolveCredentials()();

  const signer = new SignatureV4({
    service: "lambda",
    region,
    credentials,
    sha256: Hash.bind(null, "sha256"),
  });

  const headers: Record<string, string> = {
    host: parsed.host,
    "content-type": contentType,
  };

  const httpRequest = new HttpRequest({
    method: "POST",
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    path: parsed.pathname || "/",
    query: Object.fromEntries(parsed.searchParams.entries()),
    headers,
    body,
  });

  const signed = await signer.sign(httpRequest);

  return new Request(url, {
    method: signed.method,
    headers: signed.headers,
    body,
  });
}

// Lambda Function URL hostnames embed the region as the second label, e.g.
// `<id>.lambda-url.us-west-1.on.aws`. Falling back to a parsed value lets
// local dev work without an explicit AWS_REGION when the URL is correct.
function regionFromHost(host: string): string | null {
  const parts = host.split(".");
  const lambdaIdx = parts.indexOf("lambda-url");
  if (lambdaIdx >= 0 && parts[lambdaIdx + 1]) {
    return parts[lambdaIdx + 1];
  }
  return null;
}

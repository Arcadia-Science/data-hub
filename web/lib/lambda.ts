import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

const DEFAULT_REGION = "us-west-1";

// Static-credentials fallback used when AWS_ROLE_ARN is unset (local dev,
// CI). Reads env vars at call time so the value picked up matches whatever
// the surrounding process exports when `signLambdaInvoke` actually runs.
const staticCredentialsProvider: AwsCredentialIdentityProvider = async () => {
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

// Module-level cache for the OIDC provider so its internal credential cache
// (and the underlying STS AssumeRoleWithWebIdentity round-trip) is reused
// across requests on the same warm function instance. `awsCredentialsProvider`
// is itself memoizing, but only once you hold on to the same instance —
// reconstructing it per call defeats that. Keyed on AWS_ROLE_ARN so a config
// change between invocations naturally re-provisions.
let cachedCredentialsProvider: {
  key: string;
  provider: AwsCredentialIdentityProvider;
} | null = null;

function getCredentialsProvider(): AwsCredentialIdentityProvider {
  const roleArn = process.env.AWS_ROLE_ARN ?? "";
  if (cachedCredentialsProvider?.key === roleArn) {
    return cachedCredentialsProvider.provider;
  }
  const provider = roleArn
    ? awsCredentialsProvider({ roleArn })
    : staticCredentialsProvider;
  cachedCredentialsProvider = { key: roleArn, provider };
  return provider;
}

// SignatureV4 instances hold no per-request state, so memoizing per region
// avoids reconstructing them on every invocation. The signer takes a
// credentials provider (not a resolved identity), so it picks up provider
// rotations through the indirection below.
const signerByRegion = new Map<string, SignatureV4>();

function getSigner(region: string): SignatureV4 {
  let signer = signerByRegion.get(region);
  if (!signer) {
    signer = new SignatureV4({
      service: "lambda",
      region,
      credentials: () => getCredentialsProvider()(),
      sha256: Hash.bind(null, "sha256"),
    });
    signerByRegion.set(region, signer);
  }
  return signer;
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

  const signer = getSigner(region);

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

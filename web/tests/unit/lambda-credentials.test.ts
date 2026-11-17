import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests run the real `@vercel/oidc-aws-credentials-provider` and AWS
// SDK STS client against a local stand-in for STS, so they count the
// AssumeRoleWithWebIdentity calls the web app really makes.

const LAMBDA_URL = "https://example.lambda-url.us-west-1.on.aws/";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

interface FakeSts {
  calls: number;
  close: () => Promise<void>;
  failNextCall: boolean;
  url: string;
}

// Each successful call returns a new access key (AKIDTEST1, AKIDTEST2, ...)
// that expires an hour later, so a test can tell which call's credentials
// signed a request.
async function startFakeSts(): Promise<FakeSts> {
  const sts: Omit<FakeSts, "close" | "url"> = { calls: 0, failNextCall: false };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      sts.calls += 1;
      res.setHeader("content-type", "text/xml");
      if (sts.failNextCall) {
        sts.failNextCall = false;
        res.statusCode = 403;
        res.end(
          '<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">' +
            "<Error><Type>Sender</Type><Code>AccessDenied</Code>" +
            "<Message>Not authorized</Message></Error>" +
            "<RequestId>test</RequestId></ErrorResponse>"
        );
        return;
      }
      const expiration = new Date(Date.now() + HOUR_MS).toISOString();
      res.end(
        '<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">' +
          "<AssumeRoleWithWebIdentityResult><Credentials>" +
          `<AccessKeyId>AKIDTEST${sts.calls}</AccessKeyId>` +
          "<SecretAccessKey>test-secret</SecretAccessKey>" +
          "<SessionToken>test-session-token</SessionToken>" +
          `<Expiration>${expiration}</Expiration>` +
          "</Credentials></AssumeRoleWithWebIdentityResult>" +
          "<ResponseMetadata><RequestId>test</RequestId></ResponseMetadata>" +
          "</AssumeRoleWithWebIdentityResponse>"
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return Object.assign(sts, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  });
}

// The access key in a SigV4 `Authorization` header:
// `AWS4-HMAC-SHA256 Credential=<key>/<date>/<region>/lambda/aws4_request, ...`
function accessKeyOf(request: Request): string | undefined {
  return request.headers
    .get("authorization")
    ?.match(/Credential=([^/]+)\//)?.[1];
}

describe("signLambdaInvoke credentials", () => {
  let sts: FakeSts;
  let signLambdaInvoke: typeof import("@/lib/lambda").signLambdaInvoke;

  function sign() {
    return signLambdaInvoke({ url: LAMBDA_URL, body: "{}" });
  }

  beforeEach(async () => {
    sts = await startFakeSts();
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/test");
    vi.stubEnv("AWS_REGION", "us-west-1");
    vi.stubEnv("AWS_ENDPOINT_URL_STS", sts.url);
    vi.stubEnv("VERCEL_OIDC_TOKEN", "test-oidc-token");
    // `@/lib/lambda` keeps its credentials provider in module state.
    vi.resetModules();
    ({ signLambdaInvoke } = await import("@/lib/lambda"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await sts.close();
  });

  it("assumes the role once for many signed requests", async () => {
    const requests = [await sign(), await sign(), await sign()];

    expect(sts.calls).toBe(1);
    expect(requests.map(accessKeyOf)).toEqual([
      "AKIDTEST1",
      "AKIDTEST1",
      "AKIDTEST1",
    ]);
  });

  it("assumes the role again five minutes before the credentials expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(start);
    await sign();

    vi.setSystemTime(start + 54 * MINUTE_MS);
    expect(accessKeyOf(await sign())).toBe("AKIDTEST1");
    expect(sts.calls).toBe(1);

    vi.setSystemTime(start + 56 * MINUTE_MS);
    expect(accessKeyOf(await sign())).toBe("AKIDTEST2");
    expect(sts.calls).toBe(2);
  });

  it("calls STS again on the next request after a failed call", async () => {
    sts.failNextCall = true;
    await expect(sign()).rejects.toThrow("Not authorized");

    expect(accessKeyOf(await sign())).toBe("AKIDTEST2");
    expect(sts.calls).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { api, getBaseUrl } from "@/tests/integration/helpers";

// Runs against the production build so the proxy's redirect and the `/login`
// page's handling of `callbackURL` are checked as a real visitor sees them.
describe("Return to the requested page after sign-in", () => {
  it("redirects a signed-out visitor to /login with the path and query", async () => {
    const res = await api("/comments?from=2026-10-01", {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    // Next makes same-host proxy redirects relative, so parse against the app.
    const location = new URL(res.headers.get("location") ?? "", getBaseUrl());
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("callbackURL")).toBe(
      "/comments?from=2026-10-01"
    );
  });

  it("renders /login for a callbackURL that points off-site", async () => {
    const res = await api("/login?callbackURL=//evil.example", {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
  });

  it("renders /login for an OAuth sign-in that also carries callbackURL", async () => {
    const res = await api("/login?client_id=x&callbackURL=/comments", {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
  });
});

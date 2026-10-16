import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import { redirectWithAuthError } from "@/components/auth/auth-sign-in-error";

function redirectedTo(run: () => void): string {
  try {
    run();
  } catch {
    // The mocked redirect throws, like Next's.
  }
  return redirectMock.mock.calls.at(-1)?.[0] as string;
}

describe("redirectWithAuthError", () => {
  beforeEach(() => {
    redirectMock.mockReset();
    redirectMock.mockImplementation((url: string) => {
      throw new Error(`redirect:${url}`);
    });
  });

  it("keeps the login page's return address", () => {
    expect(
      redirectedTo(() =>
        redirectWithAuthError(
          "/login?callbackURL=%2Fcomments%3Fa%3D1",
          "google"
        )
      )
    ).toBe("/login?callbackURL=%2Fcomments%3Fa%3D1&error=google");
  });

  it("adds the code to a bare /login", () => {
    expect(
      redirectedTo(() => redirectWithAuthError("/login", "credentials"))
    ).toBe("/login?error=credentials");
  });

  it("keeps an in-page box's own query", () => {
    expect(
      redirectedTo(() =>
        redirectWithAuthError("/runs/a?tab=files", "credentials")
      )
    ).toBe("/runs/a?tab=files&error=credentials");
  });

  it("stays on this site for an off-site path", () => {
    expect(
      redirectedTo(() => redirectWithAuthError("//evil.example/x", "google"))
    ).toBe("/x?error=google");
  });
});

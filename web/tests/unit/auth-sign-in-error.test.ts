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

  it("keeps the return address on the login page", () => {
    expect(
      redirectedTo(() => redirectWithAuthError("/comments?a=1", "google", true))
    ).toBe("/login?callbackURL=%2Fcomments%3Fa%3D1&error=google");
  });

  it("sends the login page's default address to a bare /login", () => {
    expect(
      redirectedTo(() => redirectWithAuthError("/", "credentials", true))
    ).toBe("/login?error=credentials");
  });

  it("returns to the page itself from an in-page box, keeping its query", () => {
    expect(
      redirectedTo(() =>
        redirectWithAuthError("/runs/a?tab=files", "credentials", false)
      )
    ).toBe("/runs/a?tab=files&error=credentials");
  });

  it("uses /login for an in-page box on the home page", () => {
    expect(
      redirectedTo(() => redirectWithAuthError("/", "google", false))
    ).toBe("/login?error=google");
  });
});

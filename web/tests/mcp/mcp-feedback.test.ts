import type { AuthInfo } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userIsAdmin } from "@/lib/api/user-admin";
import { requireMcpAdmin, requireMcpWrite } from "@/lib/mcp/tools/helpers";

vi.mock("@/lib/api/user-admin", () => ({
  userIsAdmin: vi.fn(),
}));

function auth(scopes: string[]): AuthInfo {
  return {
    token: "token",
    clientId: "client",
    scopes,
    extra: { userId: "user-1" },
  };
}

describe("feedback MCP gates", () => {
  beforeEach(() => {
    vi.mocked(userIsAdmin).mockReset();
  });

  it("lets a read token through the write gate only when write is present", () => {
    expect(requireMcpWrite(auth(["read"]))).toMatchObject({ isError: true });
    expect(requireMcpWrite(auth(["read", "write"]))).toBeNull();
  });

  it("rejects non-admins", async () => {
    vi.mocked(userIsAdmin).mockResolvedValue(false);
    const result = await requireMcpAdmin(auth(["read", "write"]));
    expect(result?.isError).toBe(true);
    expect(result?.content[0]).toMatchObject({ text: "Admin role required" });
  });

  it("allows admins", async () => {
    vi.mocked(userIsAdmin).mockResolvedValue(true);
    expect(await requireMcpAdmin(auth(["read", "write"]))).toBeNull();
  });
});

import type { AuthInfo } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { limit } = vi.hoisted(() => ({
  limit: vi.fn(async (): Promise<{ name: string | null }[]> => []),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit,
        }),
      }),
    }),
  },
}));

import { isPatAuth, mcpClientLabel } from "@/lib/mcp/client-name";

function auth(clientId: string, userId = "user-1"): AuthInfo {
  return {
    token: "token",
    clientId,
    scopes: ["read"],
    extra: { userId },
  };
}

describe("mcp client name", () => {
  beforeEach(() => {
    limit.mockReset();
    limit.mockResolvedValue([]);
  });

  it("returns unknown without a client id", async () => {
    await expect(mcpClientLabel(undefined)).resolves.toBe("unknown");
    await expect(mcpClientLabel(auth("unknown"))).resolves.toBe("unknown");
    expect(limit).not.toHaveBeenCalled();
  });

  it("returns pat when the client id is the user id", async () => {
    expect(isPatAuth(auth("user-1"))).toBe(true);
    await expect(mcpClientLabel(auth("user-1"))).resolves.toBe("pat");
    expect(limit).not.toHaveBeenCalled();
  });

  it("uses the stored name, trims it, and caches it", async () => {
    limit.mockResolvedValueOnce([{ name: `  ${"Cursor".padEnd(120, "!")}  ` }]);
    const first = await mcpClientLabel(auth("client-trim"));
    const second = await mcpClientLabel(auth("client-trim"));
    expect(first).toHaveLength(100);
    expect(first.startsWith("Cursor")).toBe(true);
    expect(second).toBe(first);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("returns unknown when the client row has no name", async () => {
    limit.mockResolvedValueOnce([{ name: "   " }]);
    await expect(mcpClientLabel(auth("client-blank"))).resolves.toBe("unknown");
  });
});

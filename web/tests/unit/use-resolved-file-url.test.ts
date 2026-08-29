import { describe, expect, it, vi } from "vitest";
import { peekSyncFileUrl } from "@/hooks/use-resolved-file-url";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

describe("peekSyncFileUrl", () => {
  it("reads peekFileUrl and does not call resolveFileUrl", () => {
    const resolveFileUrl = vi.fn(() => {
      throw new Error("should not be called");
    });
    const dataSource = {
      peekFileUrl: (fileId: number) => `/api/v1/files/${fileId}/download`,
      resolveFileUrl,
    } as unknown as ReportDataSource;

    expect(peekSyncFileUrl(dataSource, 12)).toBe("/api/v1/files/12/download");
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });

  it("does not call resolveFileUrl on an async source", () => {
    const resolveFileUrl = vi.fn(() => Promise.resolve("https://s3.example/a"));
    const dataSource = {
      resolveFileUrl,
    } as unknown as ReportDataSource;

    expect(peekSyncFileUrl(dataSource, 12)).toBeUndefined();
    expect(resolveFileUrl).not.toHaveBeenCalled();
  });
});

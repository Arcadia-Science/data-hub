import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseCsvPageFromStream } from "@/lib/runs/parse-csv-page";

function csvStream(text: string): Readable {
  return Readable.from([Buffer.from(text)]);
}

describe("parseCsvPageFromStream", () => {
  const csv = "col_a,col_b\n1,2\n3,4\n5,6\n7,8\n";

  it("pages from an offset and reports the scanned total", async () => {
    const page = await parseCsvPageFromStream(csvStream(csv), 1, 2);
    expect(page.columns).toEqual(["col_a", "col_b"]);
    expect(page.rows).toEqual([
      { col_a: "3", col_b: "4" },
      { col_a: "5", col_b: "6" },
    ]);
    expect(page.total).toBe(4);
    expect(page.truncated).toBe(false);
  });

  it("clamps the returned rows to limit", async () => {
    const page = await parseCsvPageFromStream(csvStream(csv), 0, 1);
    expect(page.rows).toEqual([{ col_a: "1", col_b: "2" }]);
    expect(page.total).toBe(4);
  });

  it("stops at the scan cap and sets truncated", async () => {
    const page = await parseCsvPageFromStream(csvStream(csv), 0, 50, 2);
    expect(page.rows).toEqual([
      { col_a: "1", col_b: "2" },
      { col_a: "3", col_b: "4" },
    ]);
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(true);
  });
});

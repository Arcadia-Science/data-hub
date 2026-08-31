import { describe, expect, it } from "vitest";
import { parseQpcrMeltingPlateJson } from "@/lib/runs/qpcr-melting";

describe("parseQpcrMeltingPlateJson", () => {
  it("keeps finite points and drops invalid ones", () => {
    const plate = parseQpcrMeltingPlateJson({
      channels: [
        {
          channel: "Channel2",
          wells: [
            {
              well: "A1",
              points: [
                { x: 20, y: 0.9 },
                { x: "21", y: 1.2 },
                { x: 22, y: "nope" },
                null,
              ],
            },
          ],
        },
      ],
    });

    expect(plate.channels).toHaveLength(1);
    expect(plate.channels[0].wells[0].points).toEqual([
      { x: 20, y: 0.9 },
      { x: 21, y: 1.2 },
    ]);
  });

  it("rejects a payload without channels", () => {
    expect(() => parseQpcrMeltingPlateJson({})).toThrow(/missing channels/);
  });

  it("rejects a channel without a name", () => {
    expect(() =>
      parseQpcrMeltingPlateJson({ channels: [{ wells: [] }] })
    ).toThrow(/missing a name/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFilePreview,
  capPreviewBytes,
  decodePreviewText,
  dropPartialLastRow,
  fetchFilePreviewBytes,
  PREVIEW_BYTE_LIMIT,
} from "@/lib/runs/file-preview";

describe("capPreviewBytes", () => {
  it("keeps a file at the limit whole", () => {
    const result = capPreviewBytes(new Uint8Array(PREVIEW_BYTE_LIMIT));
    expect(result.truncated).toBe(false);
    expect(result.bytes.length).toBe(PREVIEW_BYTE_LIMIT);
  });

  it("keeps a file under the limit whole", () => {
    const result = capPreviewBytes(new Uint8Array(PREVIEW_BYTE_LIMIT - 1));
    expect(result.truncated).toBe(false);
    expect(result.bytes.length).toBe(PREVIEW_BYTE_LIMIT - 1);
  });

  it("cuts a file one byte over the limit", () => {
    const result = capPreviewBytes(new Uint8Array(PREVIEW_BYTE_LIMIT + 1));
    expect(result.truncated).toBe(true);
    expect(result.bytes.length).toBe(PREVIEW_BYTE_LIMIT);
  });
});

describe("decodePreviewText", () => {
  it("drops a character split by the cut", () => {
    const bytes = new TextEncoder().encode("ab\u00e9").subarray(0, 3);
    expect(decodePreviewText(bytes, true)).toBe("ab");
  });

  it("keeps a trailing replacement character when nothing was cut", () => {
    const bytes = new TextEncoder().encode("ab\u00e9").subarray(0, 3);
    expect(decodePreviewText(bytes, false)).toBe("ab\uFFFD");
  });

  it("decodes whole text unchanged", () => {
    const bytes = new TextEncoder().encode("h\u00e9llo");
    expect(decodePreviewText(bytes, true)).toBe("h\u00e9llo");
  });
});

describe("dropPartialLastRow", () => {
  it("keeps everything up to the last newline", () => {
    expect(dropPartialLastRow("a,b\n1,2\n3,")).toBe("a,b\n1,2\n");
  });

  it("keeps text that already ends in a newline", () => {
    expect(dropPartialLastRow("a,b\n1,2\n")).toBe("a,b\n1,2\n");
  });

  it("returns an empty string when there is no newline", () => {
    expect(dropPartialLastRow("a,b")).toBe("");
  });
});

describe("buildFilePreview", () => {
  it("parses CSV into rows", () => {
    expect(buildFilePreview("csv", "a,b\n1,2\n3,4\n", false)).toEqual({
      content: {
        kind: "table",
        rows: [
          { a: "1", b: "2" },
          { a: "3", b: "4" },
        ],
      },
      truncated: false,
    });
  });

  it("parses TSV into rows", () => {
    const { content } = buildFilePreview("tsv", "a\tb\n1,5\t2\n", false);
    expect(content).toEqual({ kind: "table", rows: [{ a: "1,5", b: "2" }] });
  });

  it("drops the partial last CSV row when cut off", () => {
    const { content, truncated } = buildFilePreview("csv", "a,b\n1,2\n3", true);
    expect(truncated).toBe(true);
    expect(content).toEqual({ kind: "table", rows: [{ a: "1", b: "2" }] });
  });

  it("shows a cut-off CSV with no whole row as text", () => {
    const text = "a,b,c,d";
    expect(buildFilePreview("csv", text, true).content).toEqual({
      kind: "text",
      text,
    });
  });

  it("keeps an untruncated header-only CSV as an empty table", () => {
    expect(buildFilePreview("csv", "a,b\n", false).content).toEqual({
      kind: "table",
      rows: [],
    });
  });

  it("pretty-prints valid JSON", () => {
    expect(buildFilePreview("json", '{"a":[1,2]}', false).content).toEqual({
      kind: "text",
      pretty: true,
      text: '{\n  "a": [\n    1,\n    2\n  ]\n}',
    });
  });

  it("shows cut-off JSON as raw text", () => {
    expect(buildFilePreview("json", '{"a":[1,', true).content).toEqual({
      kind: "text",
      text: '{"a":[1,',
    });
  });

  it("shows invalid JSON as raw text", () => {
    expect(buildFilePreview("json", "{nope", false).content).toEqual({
      kind: "text",
      text: "{nope",
    });
  });

  it("falls back to text when CSV cannot be parsed", () => {
    const text = 'a,b\n"unterminated,2\n';
    expect(buildFilePreview("csv", text, false).content).toEqual({
      kind: "text",
      text,
    });
  });

  it("returns plain text as it is", () => {
    expect(buildFilePreview("text", "hello", false)).toEqual({
      content: { kind: "text", text: "hello" },
      truncated: false,
    });
  });
});

describe("fetchFilePreviewBytes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the inline URL with a range one byte past the limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([104, 105]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const bytes = await fetchFilePreviewBytes(7, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/files/7/download?disposition=inline",
      {
        headers: { Range: `bytes=0-${PREVIEW_BYTE_LIMIT}` },
        signal: controller.signal,
      }
    );
    expect(Array.from(bytes)).toEqual([104, 105]);
  });

  it("throws with the status when the response is not OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 })
    );
    await expect(fetchFilePreviewBytes(7)).rejects.toThrow("HTTP 403");
  });

  it("treats 416 on a zero-byte file as empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 416 })
    );
    const bytes = await fetchFilePreviewBytes(7);
    expect(bytes.length).toBe(0);
  });
});

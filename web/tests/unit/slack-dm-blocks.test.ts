import { describe, expect, it } from "vitest";
import {
  buildCommentBlocks,
  buildFeedbackSubmittedBlocks,
  buildFeedbackUpdatedBlocks,
  buildGenericBlocks,
  buildRunCreatedBlocks,
} from "@/lib/slack/dm";
import { escapeMrkdwn } from "@/lib/slack/mrkdwn";

const HOSTILE_LINK = "<https://evil.example|reset your password>";
const HOSTILE_MENTION = "<!channel>";
const HOSTILE = `${HOSTILE_LINK} ${HOSTILE_MENTION} a&b`;
const ESCAPED_HOSTILE =
  "&lt;https://evil.example|reset your password&gt; &lt;!channel&gt; a&amp;b";
const RUN_URL = "https://datahub.test/instruments/inst-1/runs/run-1";

function sectionText(blocks: unknown[]): {
  text: string;
  type: string;
  verbatim?: boolean;
} {
  const [block] = blocks as {
    text: { text: string; type: string; verbatim?: boolean };
    type: string;
  }[];
  expect(block.type).toBe("section");
  return block.text;
}

function angleBracketSpans(text: string): string[] {
  return text.match(/<[^>]*>/g) ?? [];
}

describe("escapeMrkdwn", () => {
  it("escapes ampersands first so entities are not double-escaped", () => {
    expect(escapeMrkdwn("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });
});

describe("buildRunCreatedBlocks", () => {
  const blocks = buildRunCreatedBlocks({
    instrumentDisplayName: HOSTILE,
    runDisplayId: `run\`${HOSTILE_MENTION}`,
    runUrl: RUN_URL,
  });
  const text = sectionText(blocks);

  it("escapes the instrument name and run ID", () => {
    expect(text.text).toContain(`*New run on ${ESCAPED_HOSTILE}*`);
    expect(text.text).toContain("Run `run`&lt;!channel&gt;` has");
  });

  it("keeps the Data Hub link as the only angle-bracket span", () => {
    expect(angleBracketSpans(text.text)).toEqual([
      `<${RUN_URL}|View in Data Hub>`,
    ]);
  });

  it("turns off automatic mention parsing", () => {
    expect(text.type).toBe("mrkdwn");
    expect(text.verbatim).toBe(true);
  });
});

describe("buildCommentBlocks", () => {
  for (const type of ["comment_attributed", "comment_participated"] as const) {
    describe(type, () => {
      const text = sectionText(
        buildCommentBlocks({
          actorDisplayName: HOSTILE,
          instrumentDisplayName: HOSTILE,
          runDisplayId: HOSTILE,
          commentPreview: `${HOSTILE}\nsecond ${HOSTILE_MENTION}`,
          runUrl: RUN_URL,
          type,
        })
      );

      it("escapes the author, instrument, run ID and preview", () => {
        expect(text.text).toContain(`*${ESCAPED_HOSTILE}*`);
        expect(text.text).toContain(`(\`${ESCAPED_HOSTILE}\`)`);
        expect(text.text).toContain(`> ${ESCAPED_HOSTILE}`);
      });

      it("quotes every line of a multi-line preview", () => {
        expect(text.text).toContain("\n> second &lt;!channel&gt;\n");
      });

      it("keeps the Data Hub link as the only angle-bracket span", () => {
        expect(angleBracketSpans(text.text)).toEqual([
          `<${RUN_URL}|View comment>`,
        ]);
      });

      it("turns off automatic mention parsing", () => {
        expect(text.verbatim).toBe(true);
      });
    });
  }
});

describe("buildGenericBlocks", () => {
  it("escapes the sender and message and keeps the link intact", () => {
    const text = sectionText(
      buildGenericBlocks({
        actorDisplayName: HOSTILE,
        message: `${HOSTILE}\nline two`,
        runUrl: RUN_URL,
      })
    );
    expect(text.text).toContain(`*${ESCAPED_HOSTILE}* sent you`);
    expect(text.text).toContain(`:\n${ESCAPED_HOSTILE}\nline two`);
    expect(angleBracketSpans(text.text)).toEqual([
      `<${RUN_URL}|View in Data Hub>`,
    ]);
    expect(text.verbatim).toBe(true);
  });

  it("has no link when no run URL is given", () => {
    const text = sectionText(
      buildGenericBlocks({ actorDisplayName: "Bot", message: HOSTILE })
    );
    expect(angleBracketSpans(text.text)).toEqual([]);
  });
});

describe("feedback builders", () => {
  it("escape user text and turn off automatic mention parsing", () => {
    const submitted = sectionText(
      buildFeedbackSubmittedBlocks({
        actorDisplayName: HOSTILE,
        title: HOSTILE,
        feedbackUrl: "https://datahub.test/settings/feedback?item=f1",
      })
    );
    expect(submitted.text).toContain(`*${ESCAPED_HOSTILE}* sent feedback`);
    expect(angleBracketSpans(submitted.text)).toEqual([
      "<https://datahub.test/settings/feedback?item=f1|Review in Data Hub>",
    ]);
    expect(submitted.verbatim).toBe(true);

    const updated = sectionText(
      buildFeedbackUpdatedBlocks({ title: HOSTILE, statusLabel: HOSTILE })
    );
    expect(angleBracketSpans(updated.text)).toEqual([]);
    expect(updated.verbatim).toBe(true);
  });
});

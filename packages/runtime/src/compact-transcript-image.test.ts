/** W804 (stage 3): the summary input renders attachments as placeholders. */

import { describe, expect, it } from "vitest";
import { attachmentNote, transcriptLine } from "./compact/transcript.js";

const REF = { attachment_id: "b".repeat(64), media_type: "image/png" as const, width: 10, height: 20 };

describe("W804 compact transcript", () => {
  it("renders a byte-free placeholder per attachment", () => {
    expect(attachmentNote([REF])).toBe("【图：image/png 10x20】");
    expect(attachmentNote([])).toBe("");
    expect(attachmentNote(undefined)).toBe("");
  });

  it("appends placeholders to the user line and never base64", () => {
    const line = transcriptLine({ type: "user_message", text: "hi", attachments: [REF] });
    expect(line).toContain("【用户】hi");
    expect(line).toContain("【图：image/png 10x20】");
    expect(line).not.toContain("base64");
  });

  it("keeps a no-attachment line byte-identical", () => {
    expect(transcriptLine({ type: "user_message", text: "hi" })).toBe("【用户】hi\n");
  });
});

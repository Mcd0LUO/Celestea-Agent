import { describe, expect, it } from "vitest";

import { truncationNote } from "./file-io.js";

describe("W855 truncation note", () => {
  it("states the budget fact and always pairs it with a retrieval instruction", () => {
    const note = truncationNote("'a.txt'", 10, 100, "bytes", "read the rest with run_shell");
    expect(note).toContain("showing first 10 of 100 bytes (budget)");
    expect(note).toContain("read the rest with run_shell");
    // Budget wording only: an upstream-incomplete body is a different fact.
    expect(note.toLowerCase()).not.toContain("upstream");
    expect(note.toLowerCase()).not.toContain("incomplete");
  });
});

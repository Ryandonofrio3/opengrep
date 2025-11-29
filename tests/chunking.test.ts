import { describe, expect, it } from "vitest";
import { TreeSitterChunker } from "../src/lib/index/chunker";
import { buildAnchorChunk, formatChunkText } from "../src/lib/index/chunker";

describe("TreeSitterChunker fallback and splitting", () => {
  it("splits large text into overlapping chunks with preserved ordering", async () => {
    const chunker = new TreeSitterChunker();
    // Skip init and force fallback path
    (chunker as any).initialized = true;
    (chunker as any).parser = null;

    const lines = Array.from({ length: 220 }, (_, i) => `line-${i + 1}`);
    const content = lines.join("\n");

    const { chunks } = await chunker.chunk("file.ts", content);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBeGreaterThan(chunks[0].startLine);
    // Ensure monotonic progression and overlap
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine);
      expect(chunks[i].endLine).toBeGreaterThan(chunks[i].startLine);
    }
  });

  it("splits very long single-line content by characters", async () => {
    const chunker = new TreeSitterChunker();
    (chunker as any).initialized = true;
    (chunker as any).parser = null;

    const content = "a".repeat(3500);
    const { chunks } = await chunker.chunk("file.txt", content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content.length).toBeLessThanOrEqual(2000);
  });
});

describe("LocalStore chunk formatting helpers", () => {
  it("buildAnchorChunk includes imports, exports, and top comments", () => {
    const content = `// top comment
import fs from "fs";
export const value = 1;
function example() {}`;

    const anchor = buildAnchorChunk("src/example.ts", content, {
      imports: ['fs'],
      exports: ['value'],
      comments: ['// top comment']
    });

    expect(anchor.isAnchor).toBe(true);
    expect(anchor.context).toContain("Anchor");
    expect(anchor.content).toContain("Imports:");
    expect(anchor.content).toContain("Exports:");
    expect(anchor.content).toContain("Top comments:");
  });

  it("formatChunkText adds file breadcrumb when missing", () => {
    const formatted = formatChunkText({ content: "code", context: [] } as any, "/repo/path/file.ts");
    expect(formatted.startsWith("File: /repo/path/file.ts")).toBe(true);
    expect(formatted).toContain("---");
  });
});

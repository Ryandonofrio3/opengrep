import { describe, expect, it } from "vitest";
import type { SearchResponse } from "../src/lib/store";
import { cases, evaluateCase, type EvalCase } from "../src/eval";

function buildResponse(paths: string[]): SearchResponse {
  return {
    data: paths.map((p, idx) => ({
      type: "text",
      text: `chunk-${idx}`,
      score: 1,
      metadata: { path: p, hash: "h" },
    })),
  };
}

describe("eval script cases", () => {
  it("exports a non-empty case list", () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  it("returns reciprocal rank when target is present", () => {
    const evalCase: EvalCase = {
      query: "test",
      expectedPath: "match/me.ts",
    };
    const res = buildResponse(["a.ts", "match/me.ts", "c.ts"]);

    const result = evaluateCase(res, evalCase, 10);

    expect(result.found).toBe(true);
    expect(result.rr).toBeCloseTo(1 / 2);
    expect(result.recall).toBe(1);
    expect(result.timeMs).toBe(10);
  });

  it("respects avoidPath even when expected path exists", () => {
    const evalCase: EvalCase = {
      query: "test",
      expectedPath: "expected.ts",
      avoidPath: "avoid/me.ts",
    };
    const res = buildResponse(["avoid/me.ts", "expected.ts"]);

    const result = evaluateCase(res, evalCase, 5);

    expect(result.found).toBe(false);
    expect(result.rr).toBe(0);
    expect(result.recall).toBe(0);
  });

  it("handles missing paths cleanly", () => {
    const evalCase: EvalCase = {
      query: "missing",
      expectedPath: "expected.ts",
    };
    const res = buildResponse(["other.ts"]);

    const result = evaluateCase(res, evalCase, 3);

    expect(result.found).toBe(false);
    expect(result.rr).toBe(0);
    expect(result.recall).toBe(0);
  });
});

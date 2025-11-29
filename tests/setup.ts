import { vi } from "vitest";
import { CONFIG } from "../src/config";

// Avoid spinning up heavy embedding workers during tests.
const vectorDim = CONFIG.VECTOR_DIMENSIONS;
vi.mock("../src/lib/workers/worker-manager", () => {
  const makeDense = (len: number) => Array(len).fill(0);
  return {
    workerManager: {
      computeHybrid: vi.fn(async (texts: string[]) =>
        texts.map(() => ({
          dense: makeDense(vectorDim),
          colbert: Buffer.alloc(0),
          scale: 1,
        })),
      ),
      encodeQuery: vi.fn(async () => ({
        dense: makeDense(vectorDim),
        colbert: [],
      })),
      close: vi.fn(async () => { }),
    },
  };
});

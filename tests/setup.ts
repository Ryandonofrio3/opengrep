import { vi } from "vitest";
import { CONFIG } from "../src/config";

// Avoid spinning up heavy embedding workers during tests.
const vectorDim = CONFIG.VECTOR_DIM;
vi.mock("../src/lib/workers/pool", () => {
  const makeDense = (len: number) => Array(len).fill(0);
  const mockPool = {
    processFile: vi.fn(async (_input: unknown) => []),
    encodeQuery: vi.fn(async () => ({
      dense: makeDense(vectorDim),
      colbert: [],
      colbertDim: CONFIG.COLBERT_DIM,
    })),
    rerank: vi.fn(async (_input: unknown) => []),
    destroy: vi.fn(async () => {}),
  };
  return {
    getWorkerPool: () => mockPool,
    destroyWorkerPool: vi.fn(async () => {}),
    isWorkerPoolInitialized: vi.fn(() => true),
  };
});

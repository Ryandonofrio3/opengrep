import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/setup/setup-helpers", () => ({
  ensureSetup: vi.fn(async () => {}),
}));

vi.mock("../src/lib/utils/project-root", () => ({
  ensureProjectPaths: vi.fn(() => ({
    root: "/tmp/project",
    osgrepDir: "/tmp/project/.osgrep",
    lancedbDir: "/tmp/project/.osgrep/lancedb",
    cacheDir: "/tmp/project/.osgrep/cache",
    lmdbPath: "/tmp/project/.osgrep/cache/meta.lmdb",
    configPath: "/tmp/project/.osgrep/config.json",
  })),
  findProjectRoot: vi.fn(() => "/tmp/project"),
}));

vi.mock("../src/lib/index/sync-helpers", () => ({
  createIndexingSpinner: vi.fn(() => ({
    spinner: {
      text: "",
      succeed: vi.fn(),
      fail: vi.fn(),
    },
    onProgress: vi.fn(),
  })),
  formatDryRunSummary: vi.fn(() => "dry-run-summary"),
}));

vi.mock("../src/lib/index/grammar-loader", () => ({
  ensureGrammars: vi.fn(async () => {}),
}));

vi.mock("../src/lib/index/syncer", () => ({
  initialSync: vi.fn(async () => ({
    processed: 1,
    indexed: 1,
    total: 1,
    failedFiles: 0,
  })),
}));

const fakeVectorDb = {
  drop: vi.fn(async () => {}),
  createFTSIndex: vi.fn(async () => {}),
};

vi.mock("../src/lib/store/vector-db", () => ({
  VectorDB: vi.fn(() => fakeVectorDb),
}));

import { index } from "../src/commands/index";
import { createIndexingSpinner } from "../src/lib/index/sync-helpers";
import { initialSync } from "../src/lib/index/syncer";
import { ensureSetup } from "../src/lib/setup/setup-helpers";

describe("index command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs dry-run indexing without hitting store wait loop", async () => {
    await index.parseAsync(["--dry-run"], { from: "user" });

    expect(ensureSetup).toHaveBeenCalledOnce();
    expect(initialSync).toHaveBeenCalledOnce();
    const spinner = vi.mocked(createIndexingSpinner).mock.results[0]?.value
      .spinner;
    if (!spinner) {
      throw new Error("createIndexingSpinner mock missing spinner");
    }
    expect(spinner.succeed).toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { SearchResponse } from "../src/lib/store/store";
import { Searcher } from "../src/lib/search/searcher";
import { workerManager } from "../src/lib/workers/worker-manager";

type FakeTableRecord = {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  hash?: string;
  chunk_index?: number;
  is_anchor?: boolean;
  vector?: number[];
};

function buildTable({
  vectorResults,
  ftsResults,
  rowCount = 500,
}: {
  vectorResults: FakeTableRecord[];
  ftsResults?: FakeTableRecord[];
  rowCount?: number;
}) {
  const whereClauses: string[] = [];
  const normalizeRecord = (r: FakeTableRecord) => ({
    vector: [0, 0, 0, 0],
    ...r,
  });
  const normalizedVectorResults = vectorResults.map(normalizeRecord);
  const normalizedFtsResults = (ftsResults ?? []).map(normalizeRecord);
  const table = {
    countRows: vi.fn(async () => rowCount),
    search: vi.fn((query: unknown) => {
      let filterClause: string | null = null;
      const resultSet =
        typeof query === "string"
          ? normalizedFtsResults
          : normalizedVectorResults;
      const queryWrapper: any = {
        limit: vi.fn(() => queryWrapper),
        where: vi.fn((clause: string) => {
          whereClauses.push(clause);
          filterClause = clause;
          return queryWrapper;
        }),
        toArray: async () => {
          if (!filterClause) return resultSet;
          const match = /path\s+like\s+'(.+)%'/i.exec(filterClause);
          const prefix = match?.[1] ?? "";
          return resultSet.filter((r) => (r.path ?? "").startsWith(prefix));
        },
      };
      return queryWrapper;
    }),
  };
  return Object.assign(table, { lastWhereClauses: whereClauses });
}

async function runSearchWithFakeStore({
  table,
  filters,
  topK,
}: {
  table: ReturnType<typeof buildTable>;
  filters?: Record<string, unknown>;
  topK?: number;
}): Promise<SearchResponse> {
  const mockDb: any = {
    ensureTable: vi.fn(async () => table),
  };

  const searcher = new Searcher(mockDb);

  const encodeSpy = vi
    .spyOn(workerManager, "encodeQuery")
    .mockResolvedValue({
      dense: [1, 0, 0, 0],
      colbert: [],
      colbertDim: 48,
    });

  try {
    return await searcher.search(
      "store",
      "query",
      topK,
      { rerank: true },
      filters as any,
    );
  } finally {
    encodeSpy.mockRestore();
  }
}

// Unit-level fusion test: uses fake tables to exercise scoring without LanceDB
describe("Searcher.search fusion (unit)", () => {
  it("orders by dense similarity when ColBERT is absent", async () => {
    const table = buildTable({
      vectorResults: [
        {
          path: "/repo/match.ts",
          start_line: 0,
          end_line: 1,
          content: "vector match",
          hash: "h1",
          vector: [2, 0, 0, 0],
        },
        {
          path: "/repo/secondary.ts",
          start_line: 0,
          end_line: 1,
          content: "vector secondary",
          hash: "h2",
          vector: [1, 0, 0, 0],
        },
      ],
    });

    const res = await runSearchWithFakeStore({
      table,
      topK: 1,
    });

    expect(res.data[0]?.metadata?.path).toBe("/repo/match.ts");
  });

  it("keeps vector hits above FTS when only vectors have embeddings", async () => {
    const table = buildTable({
      vectorResults: [
        {
          path: "/repo/vector.ts",
          start_line: 0,
          end_line: 1,
          content: "vector",
          hash: "h1",
          vector: [1, 0, 0, 0],
        },
      ],
      ftsResults: [
        {
          path: "/repo/fts.ts",
          start_line: 0,
          end_line: 1,
          content: "fts",
          hash: "h2",
          vector: [0, 0, 0, 0],
        },
      ],
    });

    const res = await runSearchWithFakeStore({
      table,
    });

    const paths = res.data.map((c) => c.metadata?.path);
    expect(paths[0]).toBe("/repo/vector.ts");
  });

  it("applies path filters before fusion", async () => {
    const table = buildTable({
      vectorResults: [
        {
          path: "/repo/include/file.ts",
          start_line: 0,
          end_line: 1,
          content: "keep me",
          hash: "h1",
          vector: [1, 0, 0, 0],
        },
        {
          path: "/repo/exclude/file.ts",
          start_line: 0,
          end_line: 1,
          content: "drop me",
          hash: "h2",
          vector: [1, 0, 0, 0],
        },
      ],
      ftsResults: [],
    });

    const res = await runSearchWithFakeStore({
      table,
      filters: {
        all: [
          {
            key: "path",
            operator: "starts_with",
            value: "/repo/include",
          },
        ],
      },
    });

    const whereClauses = (table as any).lastWhereClauses as string[];
    expect(whereClauses.some((c) => c.includes("/repo/include"))).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.metadata?.path).toBe("/repo/include/file.ts");
  });
});

import { performance } from "node:perf_hooks";
import { cases, evaluateCase } from "../src/eval";
import { VectorDB } from "../src/lib/store/vector-db";
import { Searcher } from "../src/lib/search/searcher";
import { destroyWorkerPool } from "../src/lib/workers/pool";
import { ensureProjectPaths, findProjectRoot } from "../src/lib/utils/project-root";
import { type SearchFilter } from "../src/lib/store/types";

type Scenario = {
  name: string;
  env: Record<string, string>;
  searchOptions?: { rerank?: boolean };
};

const enableDiagnostics =
  process.env.OSGREP_SWEEP_DEBUG === "1" ||
  process.env.OSGREP_SWEEP_DEBUG === "true";

type Ranked = { path: string; score?: number };

function topPaths(response: { data: any[] }, k = 3): Ranked[] {
  return (response.data || []).slice(0, k).map((chunk) => ({
    path: chunk?.metadata?.path || "",
    score: chunk?.score ?? chunk?.generated_metadata?._score,
  }));
}

function targetRank(
  response: { data: any[] },
  expectedPath: string,
): number {
  const expectedPaths = expectedPath
    .split("|")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return response.data.findIndex((chunk: any) => {
    const path = chunk?.metadata?.path?.toLowerCase?.() || "";
    return expectedPaths.some((expected) => path.includes(expected));
  });
}

// Keep runs consistent and serial.
process.env.OSGREP_WORKER_THREADS ??= "1";
process.env.OSGREP_WORKER_COUNT ??= "1";

const scenarios: Scenario[] = [
  {
    name: "baseline-rerank-on",
    env: {},
    searchOptions: { rerank: true },
  },
  {
    name: "oldish-no-rerank-strong-boosts",
    env: {
      OSGREP_CODE_BOOST: "1.25",
      OSGREP_TEST_PENALTY: "0.85",
      OSGREP_DOC_PENALTY: "0.5",
      OSGREP_PRE_K: "300",
      OSGREP_STAGE1_K: "400",
      OSGREP_STAGE2_K: "0", // skip pooled filter
      OSGREP_MAX_PER_FILE: "50",
    },
    searchOptions: { rerank: false },
  },
  {
    name: "small-rerank-strong-boosts",
    env: {
      OSGREP_CODE_BOOST: "1.25",
      OSGREP_TEST_PENALTY: "0.85",
      OSGREP_DOC_PENALTY: "0.5",
      OSGREP_PRE_K: "300",
      OSGREP_STAGE1_K: "400",
      OSGREP_STAGE2_K: "80",
      OSGREP_MAX_PER_FILE: "50",
    },
    searchOptions: { rerank: true },
  },
  {
    name: "no-diversify-rerank",
    env: {
      OSGREP_CODE_BOOST: "1.2",
      OSGREP_TEST_PENALTY: "0.85",
      OSGREP_DOC_PENALTY: "0.7",
      OSGREP_PRE_K: "400",
      OSGREP_STAGE1_K: "500",
      OSGREP_STAGE2_K: "120",
      OSGREP_MAX_PER_FILE: "1000",
    },
    searchOptions: { rerank: true },
  },
];

async function runScenario(scenario: Scenario) {
  const touched: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(scenario.env)) {
    touched[key] = process.env[key];
    process.env[key] = value;
  }

  const searchRoot = process.cwd();
  const projectRoot = findProjectRoot(searchRoot) ?? searchRoot;
  const paths = ensureProjectPaths(projectRoot);
  const vectorDb = new VectorDB(paths.lancedbDir);
  const searcher = new Searcher(vectorDb);

  const results: ReturnType<typeof evaluateCase>[] = [];
  let drops = 0;
  let lifts = 0;
  let total = 0;
  let better = 0;
  let worse = 0;
  let unchanged = 0;

  for (const c of cases) {
    const queryStart = performance.now();
    let fusedTop: Ranked[] = [];
    let rerankTop: Ranked[] = [];
    let fusedRank = -1;

    if (enableDiagnostics && scenario.searchOptions?.rerank !== false) {
      const fusedOnly = await searcher.search(
        c.query,
        20,
        { rerank: false },
        undefined as SearchFilter | undefined,
      );
      fusedTop = topPaths(fusedOnly);
      fusedRank = targetRank(fusedOnly, c.expectedPath);
    }

    const res = await searcher.search(c.query, 20, scenario.searchOptions);
    rerankTop = topPaths(res);
    const rerankRank = enableDiagnostics
      ? targetRank(res, c.expectedPath)
      : -1;

    if (enableDiagnostics && fusedTop.length && rerankTop.length) {
      total += 1;
      const fusedBest = fusedTop[0]?.path?.toLowerCase?.() || "";
      const rerankFirstThree = rerankTop
        .slice(0, 3)
        .map((r) => r.path?.toLowerCase?.() || "");
      if (fusedBest && !rerankFirstThree.some((p) => p.includes(fusedBest))) {
        drops += 1;
        console.log(
          `[debug] ${c.query}\n  fused#1: ${fusedTop
            .map((r) => r.path)
            .join(", ")}\n  rerank#3: ${rerankTop
            .map((r) => r.path)
            .join(", ")}`,
        );
      }

      const rerankBest = rerankTop[0]?.path?.toLowerCase?.() || "";
      const fusedFirstThree = fusedTop
        .slice(0, 3)
        .map((r) => r.path?.toLowerCase?.() || "");
      if (
        rerankBest &&
        !fusedFirstThree.some((p) => p.includes(rerankBest)) &&
        fusedTop.some((r) =>
          (r.path?.toLowerCase?.() || "").includes(rerankBest),
        )
      ) {
        lifts += 1;
        console.log(
          `[lift] ${c.query}\n  fused#3: ${fusedTop
            .map((r) => r.path)
            .join(", ")}\n  rerank#1: ${rerankTop
            .map((r) => r.path)
            .join(", ")}`,
        );
      }

      if (fusedRank >= 0 && rerankRank >= 0) {
        if (rerankRank < fusedRank) {
          better += 1;
        } else if (rerankRank > fusedRank) {
          worse += 1;
          console.log(
            `[worse] ${c.query} fusedRank=${fusedRank + 1} rerankRank=${
              rerankRank + 1
            } path=${c.expectedPath}`,
          );
        } else {
          unchanged += 1;
        }
      }
    }

    const timeMs = performance.now() - queryStart;
    results.push(evaluateCase(res, c, timeMs));
  }

  const mrr = results.reduce((sum, r) => sum + r.rr, 0) / results.length;
  const recallAt10 =
    results.reduce((sum, r) => sum + r.recall, 0) / results.length;
  const avgTime =
    results.reduce((sum, r) => sum + r.timeMs, 0) / results.length;
  const found = results.filter((r) => r.found).length;

  console.log(`\n=== ${scenario.name} ===`);
  console.log(`MRR: ${mrr.toFixed(3)} | Recall@10: ${recallAt10.toFixed(3)} | Avg ms: ${avgTime.toFixed(0)} | Found: ${found}/${results.length}`);
  if (enableDiagnostics && total > 0) {
    console.log(
      `Rerank dropped fused#1 out of top3 for ${drops}/${total} queries; promoted new #1 outside fused top3 for ${lifts}/${total} queries`,
    );
    if (better + worse + unchanged > 0) {
      console.log(
        `Target rank delta: better ${better}, worse ${worse}, unchanged ${unchanged} (out of ${better + worse + unchanged})`,
      );
    }
  }

  // Restore env (best-effort) so each scenario is clean.
  for (const [key, prev] of Object.entries(touched)) {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

async function main() {
  const filter = process.argv[2];
  const runList = filter
    ? scenarios.filter((s) => s.name === filter)
    : scenarios;

  for (const scenario of runList) {
    try {
      await runScenario(scenario);
    } catch (err) {
      console.error(`Scenario ${scenario.name} failed:`, err);
    }
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await destroyWorkerPool();
  } catch {
    // Swallow cleanup errors for experiments.
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type RunResult = {
  engine: string;
  cwd: string;
  cmd: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  realSec?: number;
  userSec?: number;
  sysSec?: number;
  maxRssKb?: number;
  peakRssKb?: number;
  stdout: string;
  stderr: string;
  timeOutput: string;
};

type EngineConfig = {
  name: string;
  bin: string;
};

const DEFAULT_DATASET = path.resolve(
  __dirname,
  "../../opencode-old/packages/opencode/src",
);
const DEFAULT_OLD_BIN = path.resolve(__dirname, "../../old-osgrep/dist/index.js");
const DEFAULT_NEW_BIN = path.resolve(__dirname, "../dist/index.js");
const DEFAULT_RUNS = Number.parseInt(process.env.RUNS || "1", 10) || 1;

function parseTimeOutput(stderr: string) {
  const realSec = matchFloat(stderr, /([\d.]+)\s+real/);
  const userSec = matchFloat(stderr, /([\d.]+)\s+user/);
  const sysSec = matchFloat(stderr, /([\d.]+)\s+sys/);
  const maxRssKb = matchInt(
    stderr,
    /^\s*([\d]+)\s+maximum resident set size/mi,
  );
  const peakRssKb = matchInt(
    stderr,
    /^\s*([\d]+)\s+peak memory footprint/mi,
  );
  return { realSec, userSec, sysSec, maxRssKb, peakRssKb };
}

function matchFloat(text: string, re: RegExp) {
  const m = text.match(re);
  return m ? Number.parseFloat(m[1]) : undefined;
}

function matchInt(text: string, re: RegExp) {
  const m = text.match(re);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

function runTimedIndex(
  engine: EngineConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
): RunResult {
  const cmd = [engine.bin, "index", "--reset"];
  const timeCmd = ["/usr/bin/time", "-l", "node", ...cmd];
  const proc = spawnSync(timeCmd[0], timeCmd.slice(1), {
    cwd,
    env,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const parsed = parseTimeOutput(proc.stderr ?? "");

  return {
    engine: engine.name,
    cwd,
    cmd,
    exitCode: proc.status,
    signal: proc.signal,
    ...parsed,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    timeOutput: proc.stderr ?? "",
  };
}

function copyDataset(src: string, dest: string) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function formatMb(kb?: number) {
  if (!kb || Number.isNaN(kb)) return "n/a";
  return `${(kb / 1024).toFixed(1)} MB`;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function main() {
  const dataset = path.resolve(process.env.DATASET || DEFAULT_DATASET);
  const oldBin = path.resolve(process.env.OLD_BIN || DEFAULT_OLD_BIN);
  const newBin = path.resolve(process.env.NEW_BIN || DEFAULT_NEW_BIN);
  const runs = DEFAULT_RUNS;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "osgrep-bench-"));
  const resultsDir = path.resolve(__dirname, "../benchmark/results");
  ensureDir(resultsDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OSGREP_WORKER_THREADS: process.env.OSGREP_WORKER_THREADS || "4",
    OSGREP_WORKER_TASK_TIMEOUT_MS:
      process.env.OSGREP_WORKER_TASK_TIMEOUT_MS || "240000",
    OSGREP_LOG_PLAIN: "1",
  };

  const engines: EngineConfig[] = [
    { name: "old", bin: oldBin },
    { name: "new", bin: newBin },
  ];

  const results: RunResult[] = [];

  engines.forEach((engine) => {
    for (let i = 0; i < runs; i += 1) {
      const stageDir = path.join(tmpRoot, `${engine.name}-run-${i + 1}`);
      copyDataset(dataset, stageDir);
      const run = runTimedIndex(engine, stageDir, env);
      results.push(run);
      console.log(
        `[${engine.name}] run ${i + 1}: real=${run.realSec?.toFixed(2) ?? "?"}s rss=${formatMb(run.maxRssKb)} exit=${run.exitCode}`,
      );
    }
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(
    resultsDir,
    `engine-compare-${timestamp}.json`,
  );
  const latestPath = path.join(resultsDir, `engine-compare-latest.json`);

  const payload = {
    timestamp,
    dataset,
    runs,
    envOverrides: {
      OSGREP_WORKER_THREADS: env.OSGREP_WORKER_THREADS,
      OSGREP_WORKER_TASK_TIMEOUT_MS: env.OSGREP_WORKER_TASK_TIMEOUT_MS,
    },
    engines,
    results,
  };

  fs.writeFileSync(summaryPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2));
  console.log(`Saved results to ${summaryPath}`);
  console.log(`Latest alias: ${latestPath}`);
  console.log(`Staging kept at: ${tmpRoot}`);
}

main();

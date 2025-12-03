import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { v4 as uuidv4 } from "uuid";
import { MAX_WORKER_MEMORY_MB, WORKER_TIMEOUT_MS } from "../../config";

type WorkerRequest =
  | { id: string; hybrid: { texts: string[] } }
  | { id: string; query: { text: string } }
  | { type: "shutdown" };

type QueuedRequest = {
  buildPayload: (id: string) => WorkerRequest;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  attempts: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId?: NodeJS.Timeout;
  workerIndex: number;
  job: QueuedRequest;
};

const MAX_RETRIES = 1;
const RSS_RECYCLE_THRESHOLD_MB = 500;

export class WorkerManager {
  private workers: Array<Worker | null> = [];
  private busy: boolean[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private requestQueue: QueuedRequest[] = [];
  private isClosing = false;
  private nextWorkerIndex = 0;
  private readonly poolSize = this.resolvePoolSize();
  private readonly threadSetting = this.resolveThreadSetting();

  private resolvePoolSize(): number {
    const cores = os.cpus().length || 1;
    const pool = Math.floor(Math.min(4, cores / 2));
    return Math.max(1, pool);
  }

  private resolveThreadSetting(): string {
    const fromEnv = process.env.OSGREP_THREADS;
    if (fromEnv === "1" || fromEnv === "2") {
      return fromEnv;
    }
    return this.poolSize >= 2 ? "1" : "2";
  }

  private getWorkerConfig(): { workerPath: string; execArgv: string[] } {
    const tsWorkerPath = path.join(__dirname, "worker.ts");
    const jsWorkerPath = path.join(__dirname, "worker.js");
    const hasTsWorker = fs.existsSync(tsWorkerPath);
    const hasJsWorker = fs.existsSync(jsWorkerPath);
    const runningTs = path.extname(__filename) === ".ts";
    const isDev = (runningTs && hasTsWorker) || (hasTsWorker && !hasJsWorker);

    if (isDev) {
      return { workerPath: tsWorkerPath, execArgv: ["-r", "ts-node/register"] };
    }
    return { workerPath: jsWorkerPath, execArgv: [] };
  }

  private ensureWorkers() {
    if (this.workers.length >= this.poolSize) return;

    for (let i = this.workers.length; i < this.poolSize; i++) {
      this.workers[i] = this.createWorker(i);
      this.busy[i] = false;
    }
  }

  private ensureWorkerAt(index: number): Worker {
    this.ensureWorkers();
    const existing = this.workers[index];
    if (existing) return existing;
    const worker = this.createWorker(index);
    this.workers[index] = worker;
    this.busy[index] = false;
    return worker;
  }

  private createWorker(index: number): Worker {
    const { workerPath, execArgv } = this.getWorkerConfig();
    const worker = new Worker(workerPath, {
      execArgv,
      env: { ...process.env, OSGREP_THREADS: this.threadSetting },
    });

    worker.on("message", (message) => this.handleMessage(index, message));
    worker.on("error", (err) =>
      this.handleWorkerFailure(
        index,
        err instanceof Error ? err : new Error(String(err)),
      ),
    );
    worker.on("exit", (code) => {
      if (this.isClosing) return;
      if (code !== 0) {
        console.error(`Worker ${index} crashed (code ${code}).`);
      }
      this.requeuePendingForWorker(
        index,
        new Error(`Worker exited with code ${code}`),
      );
      this.replaceWorker(index).catch((error) =>
        console.error("Failed to replace worker after exit:", error),
      );
    });

    return worker;
  }

  private async replaceWorker(index: number) {
    const existing = this.workers[index];
    if (existing) {
      existing.removeAllListeners();
      try {
        await existing.terminate();
      } catch {
        // ignore termination errors
      }
    }
    this.workers[index] = this.createWorker(index);
    this.busy[index] = false;
  }

  private getAvailableWorkerIndex(): number | null {
    const total = this.workers.length || this.poolSize;
    for (let i = 0; i < total; i++) {
      const idx = (this.nextWorkerIndex + i) % this.poolSize;
      if (!this.busy[idx]) {
        this.nextWorkerIndex = (idx + 1) % this.poolSize;
        return idx;
      }
    }
    return null;
  }

  private dispatchQueue() {
    if (this.isClosing) return;
    this.ensureWorkers();

    let workerIndex = this.getAvailableWorkerIndex();
    while (workerIndex !== null && this.requestQueue.length > 0) {
      const job = this.requestQueue.shift();
      if (!job) break;
      this.startRequest(workerIndex, job);
      workerIndex = this.getAvailableWorkerIndex();
    }
  }

  private handleTimedOutRequest(
    workerIndex: number,
    job: QueuedRequest,
    id: string,
  ) {
    const err = new Error(`Worker request timed out after ${WORKER_TIMEOUT_MS}ms`);
    if (job.attempts <= MAX_RETRIES) {
      this.requestQueue.unshift(job);
    } else {
      job.reject(err);
    }
    this.pendingRequests.delete(id);
    this.busy[workerIndex] = false;
    this.recycleWorker(workerIndex, "Request timeout").catch((error) =>
      console.error("Failed to recycle worker after timeout:", error),
    );
    this.dispatchQueue();
  }

  private startRequest(workerIndex: number, job: QueuedRequest) {
    if (this.isClosing) {
      job.reject(new Error("WorkerManager is closing"));
      return;
    }

    const worker = this.ensureWorkerAt(workerIndex);
    job.attempts += 1;
    const id = uuidv4();
    const message = job.buildPayload(id);

    const timeoutId = setTimeout(
      () => this.handleTimedOutRequest(workerIndex, job, id),
      WORKER_TIMEOUT_MS,
    );

    this.pendingRequests.set(id, {
      resolve: job.resolve,
      reject: job.reject,
      timeoutId,
      workerIndex,
      job,
    });

    this.busy[workerIndex] = true;
    worker.postMessage(message);
  }

  private handleMessage(workerIndex: number, message: any) {
    const { id, result, query, error, memory } = message || {};
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(id);
    this.busy[workerIndex] = false;

    if (error) pending.reject(new Error(error));
    else if (result !== undefined) pending.resolve(result);
    else if (query !== undefined) pending.resolve(query);
    else pending.resolve(undefined);

    const rssMb =
      memory && memory.rss ? Math.round(memory.rss / 1024 / 1024) : 0;
    const limitMb = Math.min(MAX_WORKER_MEMORY_MB, RSS_RECYCLE_THRESHOLD_MB);
    if (rssMb > limitMb) {
      this.recycleWorker(
        workerIndex,
        `Memory limit exceeded (${rssMb}MB > ${limitMb}MB)`,
      ).catch((err) => console.error("Failed to recycle worker:", err));
      return;
    }

    this.dispatchQueue();
  }

  private requeuePendingForWorker(workerIndex: number, error: Error) {
    for (const [id, pending] of Array.from(this.pendingRequests.entries())) {
      if (pending.workerIndex !== workerIndex) continue;
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(id);
      if (pending.job.attempts <= MAX_RETRIES) {
        this.requestQueue.unshift(pending.job);
      } else {
        pending.reject(error);
      }
    }
    this.busy[workerIndex] = false;
    this.dispatchQueue();
  }

  private async handleWorkerFailure(workerIndex: number, err: Error) {
    if (this.isClosing) return;
    console.error("Worker error:", err);
    this.requeuePendingForWorker(workerIndex, err);
    await this.recycleWorker(workerIndex, "Worker error");
  }

  private async recycleWorker(workerIndex: number, reason: string) {
    const worker = this.workers[workerIndex];
    if (!worker) {
      this.workers[workerIndex] = this.createWorker(workerIndex);
      this.busy[workerIndex] = false;
      return;
    }

    console.warn(`[WorkerManager] Recycling worker ${workerIndex}: ${reason}`);
    worker.removeAllListeners();
    try {
      await worker.terminate();
    } catch {
      // ignore terminate errors
    }
    this.workers[workerIndex] = this.createWorker(workerIndex);
    this.busy[workerIndex] = false;
    this.dispatchQueue();
  }

  private queueRequest<T>(buildPayload: (id: string) => WorkerRequest): Promise<T> {
    if (this.isClosing) {
      return Promise.reject(new Error("WorkerManager is closing"));
    }

    return new Promise<T>((resolve, reject) => {
      this.requestQueue.push({
        buildPayload,
        resolve: resolve as (value: unknown) => void,
        reject,
        attempts: 0,
      });
      this.dispatchQueue();
    });
  }

  async computeHybrid(
    texts: string[],
  ): Promise<
    Array<{
      dense: Float32Array;
      colbert: Int8Array;
      scale: number;
      pooled_colbert_48d?: Float32Array;
    }>
  > {
    return this.queueRequest((id) => ({ id, hybrid: { texts } }));
  }

  async encodeQuery(
    text: string,
  ): Promise<{ dense: number[]; colbert: number[][]; colbertDim: number }> {
    return this.queueRequest((id) => ({ id, query: { text } }));
  }

  async close(): Promise<void> {
    this.isClosing = true;

    for (const pending of this.requestQueue.splice(0)) {
      pending.reject(new Error("WorkerManager is closing"));
    }

    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(new Error("WorkerManager is closing"));
      this.pendingRequests.delete(id);
    }

    const workers = [...this.workers];
    this.workers = [];
    this.busy = [];

    await Promise.all(
      workers.map(async (worker) => {
        if (!worker) return;
        worker.removeAllListeners();
        try {
          await worker.terminate();
        } catch {
          // ignore termination errors
        }
      }),
    );
  }
}

export const workerManager = new WorkerManager();

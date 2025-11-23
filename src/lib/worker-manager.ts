import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { v4 as uuidv4 } from "uuid";
import { VECTOR_CACHE_MAX, WORKER_TIMEOUT_MS } from "../config";
import { LRUCache } from "./lru";

type WorkerRequest =
  | { id: string; text: string }
  | { id: string; texts: string[] }
  | { id: string; rerank: { query: string; documents: string[] } };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  payload: WorkerRequest;
  timeoutId?: NodeJS.Timeout;
  workerIndex: number;
};

export class WorkerManager {
  private workers: Array<Worker | null> = [];
  private vectorCache = new LRUCache<string, number[]>(VECTOR_CACHE_MAX);
  private pendingRequests = new Map<string, PendingRequest>();
  private restartInFlight = new Map<number, Promise<void>>();
  private isClosing = false;
  private readonly MAX_WORKER_RSS = 6 * 1024 * 1024 * 1024; // 6GB upper bound, we restart before OOM
  private nextWorkerIndex = 0;

  constructor() {
    this.initializeWorkers();
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

  private getWorkerCount(): number {
    const desired = Math.min(os.cpus().length - 1, 4);
    return Math.max(1, desired);
  }

  private initializeWorkers() {
    const workerCount = this.getWorkerCount();
    for (let i = 0; i < workerCount; i++) {
      this.createWorker(i);
    }
  }

  private createWorker(index: number) {
    const { workerPath, execArgv } = this.getWorkerConfig();
    const worker = new Worker(workerPath, { execArgv });
    this.workers[index] = worker;

    worker.on("message", (message) => {
      const { id, vector, vectors, scores, error, memory } = message;
      const pending = this.pendingRequests.get(id);

      if (pending && pending.workerIndex === index) {
        if (pending.timeoutId) clearTimeout(pending.timeoutId);

        if (error) {
          pending.reject(new Error(error));
        } else if (vectors !== undefined) {
          pending.resolve(vectors);
        } else if (scores !== undefined) {
          pending.resolve(scores);
        } else {
          pending.resolve(vector);
        }
        this.pendingRequests.delete(id);
      }

      if (memory && memory.rss > this.MAX_WORKER_RSS) {
        console.warn(
          `Worker ${index} memory usage high (${Math.round(memory.rss / 1024 / 1024)}MB). Restarting...`,
        );
        void this.restartWorker(index, "memory limit exceeded");
      }
    });

    worker.on("error", (err) => {
      console.error(`Worker ${index} error:`, err);
      void this.restartWorker(index, `worker error: ${err.message}`);
    });

    worker.on("exit", (code) => {
      if (code !== 0 && !this.isClosing) {
        console.error(`Worker ${index} exited with code ${code}`);
        void this.restartWorker(index, `worker exit: code ${code}`);
      }
    });
  }

  private rejectPendingForWorker(workerIndex: number, error: Error) {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.workerIndex !== workerIndex) continue;
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private async restartWorker(workerIndex: number, reason?: string) {
    const inFlight = this.restartInFlight.get(workerIndex);
    if (inFlight) {
      return inFlight;
    }

    this.rejectPendingForWorker(
      workerIndex,
      new Error(`Worker restarting: ${reason || "unknown reason"}`),
    );

    const restartPromise = (async () => {
      try {
        const worker = this.workers[workerIndex];
        if (worker) {
          await worker.terminate();
        }
      } catch (err) {
        console.error("Failed to terminate worker cleanly:", err);
      }
      this.workers[workerIndex] = null;
      this.createWorker(workerIndex);
      if (reason) {
        console.warn(`Worker ${workerIndex} restarted due to ${reason}`);
      }
    })();

    this.restartInFlight.set(workerIndex, restartPromise);
    await restartPromise;
    this.restartInFlight.delete(workerIndex);
  }

  private async getNextWorker(): Promise<{ worker: Worker; index: number }> {
    const total = this.workers.length;
    if (total === 0) {
      throw new Error("No workers available");
    }

    for (let i = 0; i < total; i++) {
      const index = (this.nextWorkerIndex + i) % total;
      const restartPromise = this.restartInFlight.get(index);
      if (restartPromise) {
        await restartPromise;
      }

      const worker = this.workers[index];
      if (worker) {
        this.nextWorkerIndex = (index + 1) % total;
        return { worker, index };
      }
    }

    throw new Error("No available workers");
  }

  private async sendToWorker<T>(
    buildPayload: (id: string) => WorkerRequest,
  ): Promise<T> {
    const { worker, index } = await this.getNextWorker();

    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const payload = buildPayload(id);

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          reject(
            new Error(`Worker request timed out after ${WORKER_TIMEOUT_MS}ms`),
          );
        }
      }, WORKER_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
        payload,
        timeoutId,
        workerIndex: index,
      });
      worker.postMessage(payload);
    });
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const neededIndices: number[] = [];
    const neededTexts: string[] = [];
    const results: number[][] = new Array(texts.length);

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const cached = this.vectorCache.get(text);
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        neededIndices.push(i);
        neededTexts.push(text);
      }
    }

    if (neededTexts.length === 0) return results;

    const computedVectors = await this.sendToWorker<number[][]>((id) => ({
      id,
      texts: neededTexts,
    }));

    for (let i = 0; i < computedVectors.length; i++) {
      const originalIndex = neededIndices[i];
      const vector = computedVectors[i];
      const text = neededTexts[i];

      this.vectorCache.set(text, vector);
      results[originalIndex] = vector;
    }

    return results;
  }

  async getEmbedding(text: string): Promise<number[]> {
    const results = await this.getEmbeddings([text]);
    return results[0];
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    return this.sendToWorker<number[]>((id) => ({
      id,
      rerank: { query, documents },
    }));
  }

  async close(): Promise<void> {
    this.isClosing = true;
    try {
      for (const worker of this.workers) {
        worker?.postMessage({ type: "shutdown" });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      await Promise.all(
        this.workers.map(async (worker) => {
          if (!worker) return;
          try {
            await worker.terminate();
          } catch {
            // Silent cleanup
          }
        }),
      );
    } catch (err) {
      // Silent cleanup
    }
  }
}

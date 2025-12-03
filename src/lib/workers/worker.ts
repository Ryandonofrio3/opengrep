import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import * as ort from "onnxruntime-node";
import { AutoTokenizer, env, type PreTrainedTokenizer } from "@huggingface/transformers";
import { CONFIG, MODEL_IDS, PATHS } from "../../config";
import { ColBERTTokenizer } from "./colbert-tokenizer";

function resolveThreadCount(): number {
  const fromEnv = Number.parseInt(process.env.OSGREP_THREADS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (process.env.OSGREP_LOW_IMPACT === "1") return 1;
  const cores = os.cpus().length || 1;
  return Math.max(1, Math.min(cores - 1, 4));
}

const CACHE_DIR = PATHS.models;
const NUM_THREADS = resolveThreadCount();
const LOG_MODELS =
  process.env.OSGREP_DEBUG_MODELS === "1" ||
  process.env.OSGREP_DEBUG_MODELS === "true";
const log = (...args: unknown[]) => {
  if (LOG_MODELS) console.log(...args);
};

env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

const PROJECT_ROOT = process.cwd();
const LOCAL_MODELS = path.join(PROJECT_ROOT, "models");
if (fs.existsSync(LOCAL_MODELS)) {
  env.localModelPath = LOCAL_MODELS;
  log(`Worker: Using local models from ${LOCAL_MODELS}`);
}

type HybridResult = {
  dense: Float32Array;
  colbert: Int8Array;
  scale: number;
  pooled_colbert_48d?: Float32Array;
};

class EmbeddingWorker {
  private embedSession: ort.InferenceSession | null = null;
  private embedTokenizer: PreTrainedTokenizer | null = null;

  private colbertSession: ort.InferenceSession | null = null;
  private colbertTokenizer: ColBERTTokenizer | null = null;

  private embedModelId = MODEL_IDS.embed;
  private colbertModelId = MODEL_IDS.colbert;
  private readonly vectorDimensions = CONFIG.VECTOR_DIMENSIONS;
  private initPromise: Promise<void> | null = null;

  private resolveGranitePaths(): { modelPath: string; tokenizerPath: string } {
    const basePath = path.join(CACHE_DIR, this.embedModelId);
    const onnxDir = path.join(basePath, "onnx");
    const candidates = ["model_q4.onnx", "model.onnx"];

    for (const candidate of candidates) {
      const candidatePath = path.join(onnxDir, candidate);
      if (fs.existsSync(candidatePath)) {
        return { modelPath: candidatePath, tokenizerPath: basePath };
      }
    }

    throw new Error(
      `Granite ONNX model not found. Looked for ${candidates.join(
        ", ",
      )} in ${onnxDir}`,
    );
  }

  private async loadGranite() {
    if (this.embedSession && this.embedTokenizer) return;

    const { modelPath, tokenizerPath } = this.resolveGranitePaths();
    log(`Worker: Loading Granite ONNX session from ${modelPath}`);

    this.embedTokenizer = await AutoTokenizer.from_pretrained(tokenizerPath);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      intraOpNumThreads: NUM_THREADS,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    };
    this.embedSession = await ort.InferenceSession.create(modelPath, sessionOptions);
  }

  private async loadColbert() {
    if (this.colbertSession && this.colbertTokenizer) return;

    this.colbertTokenizer = new ColBERTTokenizer();

    let modelPath = "";
    let tokenizerPath = "";

    const devModelPath = "/Users/ryandonofrio/Desktop/osgrep2/Archive-1/models/distilled_colbert/onnx/model.onnx";
    const devTokenizerPath = "/Users/ryandonofrio/Desktop/osgrep2/Archive-1/models/distilled_colbert";

    if (fs.existsSync(devModelPath)) {
      modelPath = devModelPath;
      tokenizerPath = devTokenizerPath;
      log(`Worker: Using DEV model from ${modelPath}`);
    } else {
      const prodPath = path.join(CACHE_DIR, this.colbertModelId, "onnx", "model.onnx");
      if (fs.existsSync(prodPath)) {
        modelPath = prodPath;
        tokenizerPath = path.join(CACHE_DIR, this.colbertModelId);
      }
    }

    if (!modelPath) {
      throw new Error(
        `ColBERT ONNX model not found. Expected at ${devModelPath} or ~/.osgrep/models/${this.colbertModelId}/onnx/model.onnx`,
      );
    }

    await this.colbertTokenizer.init(tokenizerPath);

    log(`Worker: Loading native ONNX session from ${modelPath}`);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      intraOpNumThreads: NUM_THREADS,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    };

    this.colbertSession = await ort.InferenceSession.create(modelPath, sessionOptions);
  }

  async initialize() {
    if (
      this.embedSession &&
      this.embedTokenizer &&
      this.colbertSession &&
      this.colbertTokenizer
    ) {
      return;
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      log("Worker: Loading models...");
      await this.loadGranite();
      await this.loadColbert();
      log("Worker: Models loaded.");
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  private meanPool(
    hidden: Float32Array,
    attention: BigInt64Array,
    batch: number,
    seq: number,
    hiddenDim: number,
    targetDim: number,
  ): Float32Array[] {
    const vectors: Float32Array[] = [];
    const seqFromMask = attention.length / Math.max(1, batch);
    const usableSeq = Math.min(seq, seqFromMask);
    const dim = Math.min(hiddenDim, targetDim);

    for (let b = 0; b < batch; b++) {
      const sum = new Float32Array(dim);
      let count = 0;
      const attOffset = b * seqFromMask;
      const hiddenOffset = b * seq * hiddenDim;

      for (let s = 0; s < usableSeq; s++) {
        if (attention[attOffset + s] > 0) {
          count++;
          const tokenOffset = hiddenOffset + s * hiddenDim;
          for (let d = 0; d < dim; d++) {
            sum[d] += hidden[tokenOffset + d];
          }
        }
      }

      if (count === 0) count = 1;
      let norm = 0;
      for (let d = 0; d < dim; d++) {
        sum[d] /= count;
        norm += sum[d] * sum[d];
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d++) {
        sum[d] /= norm;
      }

      if (dim < targetDim) {
        const padded = new Float32Array(targetDim);
        padded.set(sum);
        vectors.push(padded);
      } else {
        vectors.push(sum);
      }
    }

    return vectors;
  }

  private async runGraniteBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.embedSession || !this.embedTokenizer) await this.initialize();
    if (!this.embedSession || !this.embedTokenizer) return [];

    const encoded = await this.embedTokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: 256,
    });

    const inputIds = encoded.input_ids.data as BigInt64Array;
    const attentionMask = encoded.attention_mask.data as BigInt64Array;
    const seqLen =
      encoded.input_ids.dims?.[1] ??
      Math.max(1, Math.floor(inputIds.length / texts.length));

    const tokenTypeIdsRaw =
      (encoded as any).token_type_ids?.data as BigInt64Array | undefined;
    const tokenTypeIds =
      tokenTypeIdsRaw && tokenTypeIdsRaw.length === inputIds.length
        ? tokenTypeIdsRaw
        : new BigInt64Array(inputIds.length).fill(BigInt(0));

    const feeds = {
      input_ids: new ort.Tensor("int64", inputIds, [texts.length, seqLen]),
      attention_mask: new ort.Tensor(
        "int64",
        attentionMask,
        [texts.length, seqLen],
      ),
      token_type_ids: new ort.Tensor(
        "int64",
        tokenTypeIds,
        [texts.length, seqLen],
      ),
    };

    const sessionOut = await this.embedSession.run(feeds);
    const hidden =
      sessionOut["last_hidden_state"] ??
      sessionOut[this.embedSession.outputNames[0]];

    if (!hidden) {
      throw new Error("Granite ONNX output missing last_hidden_state");
    }

    const hiddenData = hidden.data as Float32Array;
    const [batch, seq, dim] = hidden.dims as number[];
    return this.meanPool(
      hiddenData,
      attentionMask,
      batch,
      seq,
      dim,
      this.vectorDimensions,
    );
  }

  private async runColbertBatch(
    texts: string[],
    denseVectors: Float32Array[],
  ): Promise<HybridResult[]> {
    if (!this.colbertSession || !this.colbertTokenizer) await this.initialize();
    if (!this.colbertSession || !this.colbertTokenizer) return [];

    const encodedBatch = await Promise.all(
      texts.map((t) => this.colbertTokenizer!.encodeDoc(t)),
    );

    const maxLen = Math.max(...encodedBatch.map((e) => e.input_ids.length));
    const batchInputIds = new BigInt64Array(texts.length * maxLen);
    const batchAttentionMask = new BigInt64Array(texts.length * maxLen);
    const padId = BigInt(50283);

    for (let i = 0; i < encodedBatch.length; i++) {
      const encoded = encodedBatch[i];
      const offset = i * maxLen;
      for (let j = 0; j < maxLen; j++) {
        if (j < encoded.input_ids.length) {
          batchInputIds[offset + j] = encoded.input_ids[j];
          batchAttentionMask[offset + j] = encoded.attention_mask[j];
        } else {
          batchInputIds[offset + j] = padId;
          batchAttentionMask[offset + j] = BigInt(0);
        }
      }
    }

    const feeds = {
      input_ids: new ort.Tensor("int64", batchInputIds, [
        texts.length,
        maxLen,
      ]),
      attention_mask: new ort.Tensor("int64", batchAttentionMask, [
        texts.length,
        maxLen,
      ]),
    };

    const sessionOut = await this.colbertSession.run(feeds);
    const output = sessionOut[this.colbertSession.outputNames[0]];

    const data = output.data as Float32Array;
    const [batch, seq, dim] = output.dims as number[];
    const results: HybridResult[] = [];

    for (let b = 0; b < batch; b++) {
      const batchOffset = b * seq * dim;
      const originalLen = encodedBatch[b].input_ids.length;
      const normalized = new Float32Array(originalLen * dim);
      let maxVal = 0;

      for (let s = 0; s < originalLen; s++) {
        const offset = batchOffset + s * dim;
        let sumSq = 0;
        for (let d = 0; d < dim; d++) {
          const val = data[offset + d];
          sumSq += val * val;
        }
        const norm = Math.sqrt(sumSq) || 1;

        for (let d = 0; d < dim; d++) {
          const val = data[offset + d] / norm;
          const idx = s * dim + d;
          normalized[idx] = val;
          if (Math.abs(val) > maxVal) maxVal = Math.abs(val);
        }
      }

      if (maxVal === 0) maxVal = 1;

      const int8Array = new Int8Array(normalized.length);
      for (let i = 0; i < normalized.length; i++) {
        int8Array[i] = Math.max(
          -127,
          Math.min(127, Math.round((normalized[i] / maxVal) * 127)),
        );
      }

      const pooled = new Float32Array(dim);
      const tokenCount = Math.max(1, originalLen);
      for (let s = 0; s < originalLen; s++) {
        const tokenOffset = s * dim;
        for (let d = 0; d < dim; d++) {
          pooled[d] += normalized[tokenOffset + d];
        }
      }
      let pooledNorm = 0;
      for (let d = 0; d < dim; d++) {
        pooled[d] /= tokenCount;
        pooledNorm += pooled[d] * pooled[d];
      }
      pooledNorm = Math.sqrt(pooledNorm) || 1;
      for (let d = 0; d < dim; d++) {
        pooled[d] /= pooledNorm;
      }

      results.push({
        dense:
          denseVectors[b] ??
          new Float32Array(this.vectorDimensions).fill(0),
        colbert: int8Array,
        scale: maxVal,
        pooled_colbert_48d: pooled,
      });
    }

    return results;
  }

  async computeHybrid(texts: string[]): Promise<HybridResult[]> {
    if (!texts.length) return [];
    await this.initialize();

    const results: HybridResult[] = [];
    const BATCH_SIZE = 32;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batchTexts = texts.slice(i, i + BATCH_SIZE);
      const denseBatch = await this.runGraniteBatch(batchTexts);
      const colbertBatch = await this.runColbertBatch(batchTexts, denseBatch);
      results.push(...colbertBatch);
    }

    return results;
  }

  async encodeQuery(
    text: string,
  ): Promise<{ dense: number[]; colbert: number[][]; colbertDim: number }> {
    await this.initialize();

    const [denseVector] = await this.runGraniteBatch([text]);
    const encoded = await this.colbertTokenizer!.encodeQuery(text);

    const feeds = {
      input_ids: new ort.Tensor(
        "int64",
        encoded.input_ids,
        [1, encoded.input_ids.length],
      ),
      attention_mask: new ort.Tensor(
        "int64",
        encoded.attention_mask,
        [1, encoded.attention_mask.length],
      ),
    };

    const sessionOut = await this.colbertSession!.run(feeds);
    const output = sessionOut[this.colbertSession!.outputNames[0]];

    const data = output.data as Float32Array;
    const [, seq, dim] = output.dims as number[];

    const matrix: number[][] = [];

    for (let s = 0; s < seq; s++) {
      let sumSq = 0;
      const offset = s * dim;
      for (let d = 0; d < dim; d++) {
        const val = data[offset + d];
        sumSq += val * val;
      }
      const norm = Math.sqrt(sumSq);

      const row: number[] = [];
      if (norm > 1e-9) {
        for (let d = 0; d < dim; d++) {
          row.push(data[offset + d] / norm);
        }
      } else {
        for (let d = 0; d < dim; d++) {
          row.push(data[offset + d]);
        }
      }
      matrix.push(row);
    }

    return {
      dense: Array.from(denseVector ?? []),
      colbert: matrix,
      colbertDim: dim,
    };
  }
}

const worker = new EmbeddingWorker();

if (parentPort) {
  parentPort.on(
    "message",
    async (message: {
      id: string;
      type?: string;
      hybrid?: { texts: string[] };
      query?: { text: string };
    }) => {
      try {
        if (message.type === "shutdown") {
          process.exit(0);
          return;
        }

        if (message.hybrid) {
          const result = await worker.computeHybrid(message.hybrid.texts);
          const memory = process.memoryUsage();
          const transferList: ArrayBuffer[] = [];
          for (const entry of result) {
            if (entry.colbert?.buffer instanceof ArrayBuffer) {
              transferList.push(entry.colbert.buffer as ArrayBuffer);
            }
            if (entry.dense?.buffer instanceof ArrayBuffer) {
              transferList.push(entry.dense.buffer as ArrayBuffer);
            }
            if (entry.pooled_colbert_48d?.buffer instanceof ArrayBuffer) {
              transferList.push(entry.pooled_colbert_48d.buffer as ArrayBuffer);
            }
          }
          parentPort?.postMessage({ id: message.id, result, memory }, transferList);
          return;
        }

        if (message.query) {
          const query = await worker.encodeQuery(message.query.text);
          const memory = process.memoryUsage();
          parentPort?.postMessage({ id: message.id, query, memory });
          return;
        }

        throw new Error("Unknown message type");
      } catch (error) {
        console.error("Worker error:", error);
        parentPort?.postMessage({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

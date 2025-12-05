import * as fs from "node:fs";
import * as path from "node:path";
import {
  AutoTokenizer,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import * as ort from "onnxruntime-node";
import { CONFIG, MODEL_IDS, PATHS } from "../../../config";

const CACHE_DIR = PATHS.models;
const ONNX_THREADS = 1;
const LOG_MODELS =
  process.env.OSGREP_DEBUG_MODELS === "1" ||
  process.env.OSGREP_DEBUG_MODELS === "true";
const log = (...args: unknown[]) => {
  if (LOG_MODELS) console.log(...args);
};

export class GraniteModel {
  private session: ort.InferenceSession | null = null;
  private tokenizer: PreTrainedTokenizer | null = null;
  private readonly vectorDimensions = CONFIG.VECTOR_DIM;

  private resolvePaths(): { modelPath: string; tokenizerPath: string } {
    const basePath = path.join(CACHE_DIR, MODEL_IDS.embed);
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

  async load() {
    if (this.session && this.tokenizer) return;

    const { modelPath, tokenizerPath } = this.resolvePaths();
    log(`Worker: Loading Granite ONNX session from ${modelPath}`);

    this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerPath);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      intraOpNumThreads: ONNX_THREADS,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    };
    this.session = await ort.InferenceSession.create(modelPath, sessionOptions);
  }

  isReady(): boolean {
    return !!(this.session && this.tokenizer);
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

  async runBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.session || !this.tokenizer) return [];

    const encoded = await this.tokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: 256,
    });

    type EncodedTensor = { data: BigInt64Array; dims?: number[] };
    const inputTensor = encoded.input_ids as unknown as EncodedTensor;
    const attentionTensor = encoded.attention_mask as unknown as EncodedTensor;
    const inputIds = inputTensor.data;
    const attentionMask = attentionTensor.data;
    const seqLen =
      inputTensor.dims?.[1] ??
      Math.max(1, Math.floor(inputIds.length / texts.length));

    const tokenTypeIdsRaw = (
      encoded as Partial<{ token_type_ids: EncodedTensor }>
    ).token_type_ids;
    const tokenTypeIds =
      tokenTypeIdsRaw &&
      tokenTypeIdsRaw.data.length === inputIds.length &&
      tokenTypeIdsRaw.data.length === attentionMask.length
        ? tokenTypeIdsRaw.data
        : new BigInt64Array(inputIds.length).fill(BigInt(0));

    const feeds = {
      input_ids: new ort.Tensor("int64", inputIds, [texts.length, seqLen]),
      attention_mask: new ort.Tensor("int64", attentionMask, [
        texts.length,
        seqLen,
      ]),
      token_type_ids: new ort.Tensor("int64", tokenTypeIds, [
        texts.length,
        seqLen,
      ]),
    };

    const sessionOut = await this.session.run(feeds);
    const hidden =
      sessionOut.last_hidden_state ?? sessionOut[this.session.outputNames[0]];

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
}

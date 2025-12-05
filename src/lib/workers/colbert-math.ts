import * as fs from "node:fs";
import * as path from "node:path";
import { inner } from "simsimd";
import { MODEL_IDS, PATHS } from "../../config";

let SKIP_IDS: Set<number> | null = null;

function loadSkipIds(): Set<number> {
  if (SKIP_IDS) return SKIP_IDS;
  const basePath = path.join(PATHS.models, ...MODEL_IDS.colbert.split("/"));
  const skipPath = path.join(basePath, "skiplist.json");
  if (fs.existsSync(skipPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(skipPath, "utf8")) as number[];
      SKIP_IDS = new Set<number>(parsed.map((n) => Number(n)));
      return SKIP_IDS;
    } catch (_e) {
      // fall through to empty set
    }
  }
  SKIP_IDS = new Set<number>();
  return SKIP_IDS;
}

export function maxSim(
  queryEmbeddings: number[][] | Float32Array[],
  docEmbeddings: number[][] | Float32Array[],
  docTokenIds?: number[],
): number {
  if (queryEmbeddings.length === 0 || docEmbeddings.length === 0) {
    return 0;
  }

  const qVecs = queryEmbeddings.map((v) =>
    v instanceof Float32Array ? v : new Float32Array(v),
  );
  const dVecs = docEmbeddings.map((v) =>
    v instanceof Float32Array ? v : new Float32Array(v),
  );
  const dTokenIds =
    docTokenIds && docTokenIds.length === dVecs.length ? docTokenIds : null;
  const skipIds = loadSkipIds();

  let totalScore = 0;
  for (const qVec of qVecs) {
    let maxDotProduct = -Infinity;
    for (let idx = 0; idx < dVecs.length; idx++) {
      const tokenId = dTokenIds ? dTokenIds[idx] : null;
      if (tokenId !== null && skipIds.has(Number(tokenId))) continue;
      const dVec = dVecs[idx];
      const dim = Math.min(qVec.length, dVec.length);
      const dot = inner(qVec.subarray(0, dim), dVec.subarray(0, dim));
      if (dot > maxDotProduct) maxDotProduct = dot;
    }
    totalScore += maxDotProduct;
  }

  return totalScore;
}

export function cosineSim(
  a: number[] | Float32Array,
  b: number[] | Float32Array,
): number {
  const aVec = a instanceof Float32Array ? a : new Float32Array(a);
  const bVec = b instanceof Float32Array ? b : new Float32Array(b);

  const dim = Math.min(aVec.length, bVec.length);
  if (aVec.length !== bVec.length) {
    return inner(aVec.subarray(0, dim), bVec.subarray(0, dim));
  }
  return inner(aVec, bVec);
}

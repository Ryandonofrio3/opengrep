// src/lib/colbert-math.ts

/**
 * Computes the MaxSim score between a Query and a Document.
 * * Late Interaction mechanism:
 * 1. For every token in the Query...
 * 2. Find the maximum similarity (dot product) with ANY token in the Document.
 * 3. Sum those maximums.
 * * @param queryEmbeddings - Array of vectors [seq_len_q, dim]
 * @param docEmbeddings - Array of vectors [seq_len_d, dim]
 */
export function maxSim(
  queryEmbeddings: number[][],
  docEmbeddings: number[][],
): number {
  if (queryEmbeddings.length === 0 || docEmbeddings.length === 0) {
    return 0;
  }

  // We assume normalized embeddings (dot product = cosine similarity)
  let totalScore = 0;

  // Iterate over every query token
  for (const qVec of queryEmbeddings) {
    let maxDotProduct = -Infinity;

    // Compare against every document token
    for (const dVec of docEmbeddings) {
      // Compute Dot Product
      let dot = 0;
      // Safety: Use the smaller dimension to avoid NaN if models mismatch
      const limit = Math.min(qVec.length, dVec.length);
      for (let i = 0; i < limit; i++) {
        dot += qVec[i] * dVec[i];
      }

      if (dot > maxDotProduct) {
        maxDotProduct = dot;
      }
    }

    // Sum the best matches
    totalScore += maxDotProduct;
  }

  return totalScore;
}

/**
 * Computes the Cosine Similarity between two vectors.
 */
export function cosineSim(a: number[], b: number[]): number {
  const dim = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < dim; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
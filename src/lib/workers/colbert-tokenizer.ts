import {
  AutoTokenizer,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";

const QUERY_MARKER_TOKEN = "[Q] ";
const DOC_MARKER_TOKEN = "[D] ";
const MASK_TOKEN = "[MASK]";
const QUERY_MAXLEN = 32; // Standard ColBERT query length
const DOC_MAXLEN = 512; // Standard ColBERT document length

export class ColBERTTokenizer {
  private tokenizer: PreTrainedTokenizer | null = null;
  private specialTokenIds: {
    cls: number;
    sep: number;
    pad: number;
    mask: number;
    queryMarker: number;
    docMarker: number;
  } | null = null;

  async init(modelPath: string) {
    this.tokenizer = await AutoTokenizer.from_pretrained(modelPath);

    // Get special token IDs with fallbacks
    // We use the IDs we discovered in validation: [Q]=50368, [D]=50369
    // But we still try to look them up dynamically first.

    const tokenizer = this.tokenizer;
    const get = (token: string) => tokenizer?.model.tokens_to_ids.get(token);

    const specialTokens = tokenizer as Partial<{
      cls_token: string;
      sep_token: string;
      pad_token: string;
    }>;
    const clsId = get(specialTokens.cls_token ?? "[CLS]") ?? 50281;
    const sepId = get(specialTokens.sep_token ?? "[SEP]") ?? 50282;
    const padId = get(specialTokens.pad_token ?? "[PAD]") ?? 50283;
    const maskId = get(MASK_TOKEN) ?? 50284;
    const queryMarkerId = get(QUERY_MARKER_TOKEN) ?? 50368;
    const docMarkerId = get(DOC_MARKER_TOKEN) ?? 50369;

    this.specialTokenIds = {
      cls: clsId,
      sep: sepId,
      pad: padId,
      mask: maskId,
      queryMarker: queryMarkerId,
      docMarker: docMarkerId,
    };
  }

  async encodeQuery(
    text: string,
  ): Promise<{ input_ids: bigint[]; attention_mask: bigint[] }> {
    if (!this.tokenizer || !this.specialTokenIds) {
      throw new Error("Tokenizer not initialized. Call init() first.");
    }

    // Tokenize without special tokens
    const encoded = await this.tokenizer(text, {
      add_special_tokens: false,
      truncation: true,
      max_length: QUERY_MAXLEN - 2, // Reserve space for [CLS] and [Q]
    });

    const { input_ids } = encoded;

    // Build sequence: [CLS] [Q] token1 token2 ... [SEP] [MASK] [MASK] ...
    const finalIds: number[] = [
      this.specialTokenIds.cls,
      this.specialTokenIds.queryMarker,
      ...Array.from(input_ids.data as BigInt64Array).map(Number),
      this.specialTokenIds.sep,
    ];

    // Query Expansion: pad with [MASK] tokens up to QUERY_MAXLEN
    while (finalIds.length < QUERY_MAXLEN) {
      finalIds.push(this.specialTokenIds.mask);
    }

    // Truncate if somehow longer (safety check)
    if (finalIds.length > QUERY_MAXLEN) {
      finalIds.length = QUERY_MAXLEN;
    }

    // Create attention mask (1 for all tokens, since MASK is also attended to)
    const attentionMask = new Array(finalIds.length).fill(1);

    return {
      input_ids: finalIds.map((id) => BigInt(id)),
      attention_mask: attentionMask.map((v) => BigInt(v)),
    };
  }

  async encodeDoc(
    text: string,
  ): Promise<{ input_ids: bigint[]; attention_mask: bigint[] }> {
    if (!this.tokenizer || !this.specialTokenIds) {
      throw new Error("Tokenizer not initialized. Call init() first.");
    }

    // Tokenize without special tokens
    const encoded = await this.tokenizer(text, {
      add_special_tokens: false,
      truncation: true,
      max_length: DOC_MAXLEN - 3, // Reserve space for [CLS], [D], and [SEP]
    });

    const { input_ids } = encoded;

    // Build sequence: [CLS] [D] token1 token2 ... [SEP]
    const finalIds: number[] = [
      this.specialTokenIds.cls,
      this.specialTokenIds.docMarker,
      ...Array.from(input_ids.data as BigInt64Array).map(Number),
      this.specialTokenIds.sep,
    ];

    // Create attention mask
    const attentionMask = new Array(finalIds.length).fill(1);

    return {
      input_ids: finalIds.map((id) => BigInt(id)),
      attention_mask: attentionMask.map((v) => BigInt(v)),
    };
  }
}

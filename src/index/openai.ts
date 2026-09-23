/**
 * OpenAI embeddings.
 *
 * The privacy trade-off, stated plainly because it is the one thing about WhatMCP
 * that is not local: indexing sends every conversation window to OpenAI once, and
 * every search sends the query text. The archive, the vectors, and the search
 * itself stay on this machine; the embedding call does not. The API key lives only
 * in ~/.whatmcp/config.json (0600) or the environment — never in the archive,
 * never logged, never passed on a command line where `ps` would show it.
 *
 * Unlike E5-family models, text-embedding-3-* take no "query:"/"passage:" prefix.
 * Adding one would be a silent quality regression, so there is no prefix logic
 * here to accidentally inherit.
 */

const ENDPOINT = 'https://api.openai.com/v1/embeddings';

export interface EmbedConfig {
  model: string;
  /**
   * Output width. These models are Matryoshka-trained, so a shortened vector stays
   * coherent — unlike naive truncation of an ordinary embedding.
   */
  dimensions: number;
  apiKey: string;
}

/** Identity written into window_vectors.model. Changing either field invalidates. */
export function modelTag(cfg: { model: string; dimensions: number }): string {
  return `openai/${cfg.model}@${cfg.dimensions}`;
}

/**
 * Rough token estimate for batching. Deliberately pessimistic: accented text,
 * non-Latin scripts and emoji all tokenize worse than plain English, and the
 * cost of over-splitting a batch is one extra round trip, while under-splitting
 * is a hard 400.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 2.5);
}

const MAX_INPUTS_PER_REQUEST = 256;
const MAX_TOKENS_PER_REQUEST = 250_000; // under the documented 300k ceiling
export const MAX_TOKENS_PER_INPUT = 8_000; // model limit is 8192

export interface Batch {
  texts: string[];
  truncated: number;
}

export function splitBatches(texts: string[]): Batch[] {
  const batches: Batch[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  let curTrunc = 0;

  for (const t of texts) {
    // A single over-long window is truncated rather than failing the whole run.
    // With the chunker's 4,000-char cap this should never fire; it exists so a
    // future cap change degrades instead of erroring.
    const over = estimateTokens(t) > MAX_TOKENS_PER_INPUT;
    const text = over ? t.slice(0, MAX_TOKENS_PER_INPUT * 2) : t;
    const tk = estimateTokens(text);

    if (cur.length >= MAX_INPUTS_PER_REQUEST || curTokens + tk > MAX_TOKENS_PER_REQUEST) {
      if (cur.length > 0) batches.push({ texts: cur, truncated: curTrunc });
      cur = [];
      curTokens = 0;
      curTrunc = 0;
    }
    cur.push(text);
    curTokens += tk;
    if (over) curTrunc++;
  }
  if (cur.length > 0) batches.push({ texts: cur, truncated: curTrunc });
  return batches;
}

// Plain field assignment rather than a TypeScript parameter property: this project
// runs under --experimental-strip-types, which only erases annotations and cannot
// emit the constructor assignment a parameter property implies.
class RetryableError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Redact anything key-shaped before it can reach a log or an error message. */
export function redact(s: string): string {
  return s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***');
}

/** Only this input-specific failure may be isolated and deferred by the indexer. */
export class InputTooLongError extends Error {}

async function post(cfg: EmbedConfig, input: string[], signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        input,
        dimensions: cfg.dimensions,
        encoding_format: 'float',
      }),
    });
  } catch (e) {
    // Network-level failures are transient far more often than not; a flaky
    // connection should not end a 20-minute indexing run.
    throw new RetryableError(`network: ${(e as Error).message}`, 2000);
  }

  if (res.status === 429 || res.status >= 500) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000;
    throw new RetryableError(`HTTP ${res.status}`, retryAfter || 2000);
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400) {
      try {
        const error = JSON.parse(body)?.error;
        if (error?.type === 'invalid_request_error' &&
            typeof error.message === 'string' &&
            /maximum (?:input|context) length is \d+ tokens/i.test(error.message)) {
          throw new InputTooLongError('Embedding input exceeds the model token limit.');
        }
      } catch (e) {
        if (e instanceof InputTooLongError) throw e;
      }
    }
    if (res.status === 401) {
      throw new Error(
        'OpenAI rejected the API key (401). Replace it with:  npm run wa -- set-key',
      );
    }
    throw new Error(`OpenAI ${res.status}: ${redact(body.slice(0, 300))}`);
  }
  return (await res.json()) as {
    data: { index: number; embedding: number[] }[];
    usage?: { total_tokens: number };
  };
}

/** L2-normalize so downstream cosine is a plain dot product. */
function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

export interface EmbedBatchResult {
  vectors: Float32Array[];
  tokens: number;
}

export async function embed(
  cfg: EmbedConfig,
  texts: string[],
  opts: { signal?: AbortSignal; maxRetries?: number } = {},
): Promise<EmbedBatchResult> {
  if (texts.length === 0) return { vectors: [], tokens: 0 };
  const maxRetries = opts.maxRetries ?? 5;

  let attempt = 0;
  for (;;) {
    try {
      const json = await post(cfg, texts, opts.signal);
      // The API does not guarantee response order; place by index explicitly.
      const out = new Array<Float32Array>(texts.length);
      for (const d of json.data) out[d.index] = normalize(d.embedding);
      for (let i = 0; i < out.length; i++) {
        if (!out[i]) throw new Error(`missing embedding for input ${i}`);
      }
      if (out[0].length !== cfg.dimensions) {
        throw new Error(
          `expected ${cfg.dimensions}-dim vectors, got ${out[0].length}. ` +
            `The archive's vectors would be unusable; aborting rather than storing them.`,
        );
      }
      return { vectors: out, tokens: json.usage?.total_tokens ?? 0 };
    } catch (e) {
      if (e instanceof RetryableError && attempt < maxRetries) {
        const backoff = Math.min(e.retryAfterMs * 2 ** attempt, 60_000);
        await new Promise((r) => setTimeout(r, backoff));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

/** Price per 1M input tokens, for the cost estimate shown before a large run. */
const PRICE_PER_MTOK: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
};

export function estimateCostUSD(model: string, tokens: number): number {
  const rate = PRICE_PER_MTOK[model];
  if (rate === undefined) return 0;
  return (tokens / 1_000_000) * rate;
}

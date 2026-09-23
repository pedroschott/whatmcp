/**
 * Embed every window that has no vector yet.
 *
 * Resumable for free: the pending set is derived from a LEFT JOIN rather than a
 * stored cursor, and each batch commits on its own. Kill the process mid-run and
 * the next one picks up exactly where it stopped — there is no checkpoint state
 * that can disagree with the data.
 *
 * Deliberately NOT inside the indexer's transaction. node:sqlite is synchronous
 * and embedding is async, so awaiting inside BEGIN/COMMIT would hold a write
 * transaction open across minutes of HTTP round trips.
 */

import { openStore, type DB } from '../db/index.ts';
import { windowHash } from './chunker.ts';
import {
  embed as apiEmbed, splitBatches, modelTag, estimateTokens,
  estimateCostUSD, MAX_TOKENS_PER_INPUT, InputTooLongError, type EmbedConfig,
} from './openai.ts';

// The archive is written and read on the same machine, but a byte-swapped
// Float32Array produces *plausible garbage rankings* rather than an error, which
// is the worst way for this to fail. Assert rather than hope.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
if (!LITTLE_ENDIAN) {
  throw new Error('big-endian host: vector BLOBs are little-endian float32');
}

export function packVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export type ProgressEvent =
  | { phase: 'start'; pending: number; total: number; model: string; dim: number;
      estTokens: number; estCostUSD: number }
  | { phase: 'progress'; done: number; pending: number; rate: number; etaMs: number;
      tokens: number }
  | { phase: 'warn'; code: string; detail: string }
  | { phase: 'done'; embedded: number; skipped: number; failed: number; truncated: number;
      tokens: number; costUSD: number; elapsedMs: number };

export interface EmbedOptions {
  batchSize?: number;
  onProgress?: (e: ProgressEvent) => void;
  signal?: AbortSignal;
  /** Stop after this many windows. Used by `embed --limit` to sample cost. */
  limit?: number;
}

export interface EmbedResult {
  embedded: number;
  /** Oversized windows left without vectors so a later run retries them. */
  failed: number;
  skipped: number;
  pending: number;
  truncated: number;
  tokens: number;
  costUSD: number;
  elapsedMs: number;
}

/** Fill content_hash for any window written before hashing, or by an older build. */
export function backfillHashes(db: DB): number {
  const rows = db
    .prepare('SELECT id, thread_id, speakers, text FROM windows WHERE content_hash IS NULL')
    .all() as { id: number; thread_id: string; speakers: string; text: string }[];
  if (rows.length === 0) return 0;

  const upd = db.prepare('UPDATE windows SET content_hash = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) upd.run(windowHash(r), r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

/**
 * What a sync would cost, without embedding anything.
 *
 * Separate from embedMissing because the obvious shortcut -- calling it with
 * limit 0 -- reports zero pending rather than an estimate, since the limit is
 * applied before the count. Anyone showing a user a price before asking them to
 * approve it needs the real number.
 */
export function estimatePending(
  storePath: string,
  cfg: { model: string; dimensions: number },
): { pending: number; tokens: number; costUSD: number } {
  const db = openStore(storePath);
  try {
    backfillHashes(db);
    const rows = db.prepare(`
      SELECT DISTINCT w.content_hash AS hash, w.text AS text
      FROM windows w
      LEFT JOIN window_vectors v
        ON v.content_hash = w.content_hash AND v.model = ?
      WHERE v.content_hash IS NULL AND w.content_hash IS NOT NULL
    `).all(modelTag(cfg)) as { hash: string; text: string }[];
    const tokens = rows.reduce((n, r) => n + estimateTokens(r.text), 0);
    return { pending: rows.length, tokens, costUSD: estimateCostUSD(cfg.model, tokens) };
  } finally {
    db.close();
  }
}

export async function embedMissing(
  storePath: string,
  cfg: EmbedConfig,
  opts: EmbedOptions = {},
): Promise<EmbedResult> {
  const t0 = Date.now();
  const batchSize = opts.batchSize ?? 128;
  const tag = modelTag(cfg);
  const emit = opts.onProgress ?? (() => {});

  const db = openStore(storePath);
  try {
    const backfilled = backfillHashes(db);
    if (backfilled > 0) {
      emit({ phase: 'warn', code: 'backfilled_hashes', detail: String(backfilled) });
    }

    /*
     * DISTINCT collapses windows whose content is byte-identical, so a recurring
     * exchange costs one embedding instead of many. On a real corpus this is a
     * few percent of windows — small, but it is free.
     */
    let pending = db
      .prepare(`
        SELECT DISTINCT w.content_hash AS hash, w.text AS text
        FROM windows w
        LEFT JOIN window_vectors v
          ON v.content_hash = w.content_hash AND v.model = ?
        WHERE v.content_hash IS NULL AND w.content_hash IS NOT NULL
        ORDER BY w.content_hash
      `)
      .all(tag) as { hash: string; text: string }[];

    if (opts.limit !== undefined) pending = pending.slice(0, opts.limit);

    const total = Number((db.prepare('SELECT COUNT(*) c FROM windows').get() as any).c);
    const estTokens = pending.reduce((n, p) => n + estimateTokens(p.text), 0);

    emit({
      phase: 'start',
      pending: pending.length,
      total,
      model: tag,
      dim: cfg.dimensions,
      estTokens,
      estCostUSD: estimateCostUSD(cfg.model, estTokens),
    });

    if (pending.length === 0) {
      const res = {
        embedded: 0, failed: 0, skipped: total, pending: 0, truncated: 0,
        tokens: 0, costUSD: 0, elapsedMs: Date.now() - t0,
      };
      emit({ phase: 'done', embedded: 0, failed: 0, skipped: total, truncated: 0,
             tokens: 0, costUSD: 0, elapsedMs: res.elapsedMs });
      return res;
    }

    const ins = db.prepare(`
      INSERT INTO window_vectors (content_hash, model, dim, truncated, created_at, vec)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash, model) DO NOTHING
    `);

    let embedded = 0;
    let failed = 0;
    let truncated = 0;
    let tokens = 0;
    let lastEmit = 0;
    const rateWindow: { at: number; done: number }[] = [{ at: Date.now(), done: 0 }];

    // Split rejected batches until the oversized window is isolated. Persist each
    // successful subset immediately; never write a placeholder vector for failures.
    const processBatch = async (rows: { hash: string; text: string }[], texts: string[]): Promise<void> => {
      opts.signal?.throwIfAborted();
      let result: Awaited<ReturnType<typeof apiEmbed>>;
      try {
        result = await apiEmbed(cfg, texts, { signal: opts.signal });
      } catch (e) {
        if (!(e instanceof InputTooLongError)) throw e;
        if (texts.length > 1) {
          const mid = Math.floor(texts.length / 2);
          await processBatch(rows.slice(0, mid), texts.slice(0, mid));
          await processBatch(rows.slice(mid), texts.slice(mid));
        } else {
          failed++;
          emit({ phase: 'warn', code: 'input_too_long',
            detail: `window ${rows[0].hash} left pending; continuing with other windows` });
        }
        return;
      }
      tokens += result.tokens;
      let batchTruncated = 0;
      db.exec('BEGIN');
      try {
        const now = Math.floor(Date.now() / 1000);
        for (let j = 0; j < rows.length; j++) {
          const src = rows[j];
          const isTrunc = estimateTokens(src.text) > MAX_TOKENS_PER_INPUT ? 1 : 0;
          batchTruncated += isTrunc;
          ins.run(src.hash, tag, cfg.dimensions, isTrunc, now, packVector(result.vectors[j]));
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      embedded += rows.length;
      truncated += batchTruncated;
    };

    for (let i = 0; i < pending.length; i += batchSize) {
      if (opts.signal?.aborted) break;

      const slice = pending.slice(i, i + batchSize);
      // splitBatches enforces the API's own per-request input and token ceilings,
      // so batchSize is an upper bound rather than the actual request size.
      const batches = splitBatches(slice.map((s) => s.text));

      let offset = 0;
      for (const batch of batches) {
        await processBatch(slice.slice(offset, offset + batch.texts.length), batch.texts);
        offset += batch.texts.length;
      }

      // Rate over a trailing window. A cumulative rate is dominated by the first
      // slow request and reads visibly wrong for the first half-minute.
      rateWindow.push({ at: Date.now(), done: embedded });
      if (rateWindow.length > 10) rateWindow.shift();
      const span = rateWindow[rateWindow.length - 1].at - rateWindow[0].at;
      const spanDone = rateWindow[rateWindow.length - 1].done - rateWindow[0].done;
      const rate = span > 0 ? (spanDone / span) * 1000 : 0;

      if (Date.now() - lastEmit >= 250 || embedded + failed >= pending.length) {
        lastEmit = Date.now();
        emit({
          phase: 'progress',
          done: embedded,
          pending: pending.length,
          rate: Number(rate.toFixed(1)),
          etaMs: rate > 0 ? Math.round(((pending.length - embedded - failed) / rate) * 1000) : 0,
          tokens,
        });
      }
    }

    const costUSD = estimateCostUSD(cfg.model, tokens);
    const res = {
      embedded,
      failed,
      skipped: total - embedded,
      pending: pending.length - embedded,
      truncated,
      tokens,
      costUSD,
      elapsedMs: Date.now() - t0,
    };
    emit({
      phase: 'done', embedded, failed, skipped: res.skipped, truncated,
      tokens, costUSD, elapsedMs: res.elapsedMs,
    });
    return res;
  } finally {
    db.close();
  }
}

/** Vector coverage, for get_stats and doctor. */
export function vectorCoverage(db: DB, cfg: { model: string; dimensions: number }) {
  const tag = modelTag(cfg);
  const row = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM windows) AS windows,
        (SELECT COUNT(*) FROM windows w
           JOIN window_vectors v
             ON v.content_hash = w.content_hash AND v.model = ?) AS embedded
    `)
    .get(tag) as { windows: number; embedded: number };
  const windows = Number(row.windows);
  const embedded = Number(row.embedded);
  return {
    model: tag,
    windows,
    embedded,
    pct: windows ? Math.round((embedded / windows) * 100) : 0,
  };
}

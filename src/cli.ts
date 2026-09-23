#!/usr/bin/env node
/** WhatMCP CLI — build the archive, inspect it, tune it. */

import { runIndex } from './index/indexer.ts';
import { embedMissing, vectorCoverage, type ProgressEvent } from './index/embed.ts';
import { modelTag } from './index/openai.ts';
import {
  searchHybrid, listThreads, listPeople, getConversation, stats,
  type SearchContext,
} from './search/search.ts';
import { openStore } from './db/index.ts';
import { getStore } from './store.ts';
import * as wa from './whatsapp/source.ts';
import {
  loadConfig, embedConfig, writeFileConfig, maskKey, requireKey,
  CONFIG_PATH, DATA_DIR, ensureDataDir, type Config,
} from './config.ts';
import { calibrateThresholds, NOISE_PROBES } from './search/calibrate.ts';
import { existsSync, statSync, rmSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { listClients, revokeClient } from './mcp/oauth.ts';
import { runSetup, installSyncAgent } from './setup.ts';
import { runPreflight } from './preflight.ts';
import { dirname, join } from 'node:path';
import { readSecret } from './secret-input.ts';

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const flag = (name: string) => rest.includes(`--${name}`);
const flagValue = (name: string, fallback?: string) => {
  const hit = rest.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const positional = rest.filter((a) => !a.startsWith('--'));

const fmtTs = (ts: number) =>
  ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never';
const fmtBytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function onProgress(e: ProgressEvent) {
  if (e.phase === 'start') {
    if (e.pending === 0) {
      console.log(`  all ${e.total} window(s) already embedded with ${e.model}`);
      return;
    }
    console.log(
      `  ${e.pending} window(s) to embed with ${e.model}\n` +
        `  ~${e.estTokens.toLocaleString()} tokens, est. $${e.estCostUSD.toFixed(4)}`,
    );
  } else if (e.phase === 'progress') {
    const eta = e.etaMs > 0 ? `  eta ${Math.ceil(e.etaMs / 1000)}s` : '';
    process.stdout.write(`\r  ${e.done}/${e.pending}  ${e.rate}/s${eta}      `);
  } else if (e.phase === 'warn') {
    console.log(`\n  warn: ${e.code} ${e.detail}`);
  } else if (e.phase === 'done' && (e.embedded > 0 || e.failed > 0)) {
    process.stdout.write('\r');
    console.log(
      `  embedded ${e.embedded} in ${(e.elapsedMs / 1000).toFixed(1)}s, ` +
        `${e.tokens.toLocaleString()} tokens, $${e.costUSD.toFixed(4)}` +
        (e.truncated ? `  (${e.truncated} truncated)` : '') +
        (e.failed ? `\n  ${e.failed} oversized window(s) left pending for a future run.` : ''),
    );
  }
}

/**
 * Fit thresholds the first time an archive acquires vectors.
 *
 * `setup` calibrates right after the embed it runs itself, but that is only the
 * happy path: anyone who answers "no" to the one prompt that costs money and
 * embeds later via `embed` or `sync` would otherwise be left on the compiled-in
 * defaults forever. Those defaults are a guess against an unknown corpus, and
 * when they are wrong the vector arm silently returns nothing — search still
 * reports results, just keyword-only ones, which reads as "this doesn't work"
 * rather than "this needs one more command".
 *
 * Only fires when the thresholds have never been written, so it never overrides
 * a value someone tuned by hand.
 */
async function calibrateIfUnset(cfg: Config, embedded: number): Promise<void> {
  if (cfg.strongSim !== undefined || embedded === 0) return;
  process.stdout.write('  fitting relevance thresholds to this corpus… ');
  try {
    const r = await calibrateThresholds(cfg);
    console.log(r ? `strong=${r.strong} min=${r.minSim}` : 'skipped (no vectors)');
  } catch (e) {
    // Never fail an otherwise-successful embed over a tuning pass. The archive is
    // built and usable; `calibrate` can be re-run at any time.
    console.log(`skipped (${(e as Error).message})`);
    console.log(dim('  run `npm run wa -- calibrate` once the API is reachable'));
  }
}

/**
 * Search context that tolerates a missing API key.
 *
 * Only the vector arm needs the key; BM25, chats, people and doctor do not. Making
 * every read path require one would mean a user cannot so much as list their chats
 * before pasting a key — and doctor, whose entire job is to diagnose a missing key,
 * would crash on it.
 */
function ctx(): SearchContext {
  const cfg = loadConfig();
  return {
    storePath: cfg.store,
    embedCfg: {
      model: cfg.openaiModel,
      dimensions: cfg.openaiDims,
      apiKey: cfg.openaiKey ?? '',
    },
  };
}

switch (cmd) {
  case 'setup': {
    await runSetup();
    break;
  }

  /* Set the background sync cadence without the wizard. */
  case 'sync-every': {
    const hours = Math.max(0, Number(positional[0]));
    if (!positional.length || Number.isNaN(hours)) {
      console.error('usage: npm run wa -- sync-every <hours>   (0 disables)');
      process.exit(1);
    }
    writeFileConfig({ sync_interval_hours: hours });
    const uid = String(process.getuid?.() ?? 501);
    if (hours === 0) {
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}/com.whatmcp.sync`], { stdio: 'ignore' });
      } catch { /* not loaded */ }
      console.log('background sync disabled; run `npm run sync` manually');
    } else {
      installSyncAgent(hours);
      console.log(`syncing every ${hours}h — logs at ~/.whatmcp/logs/sync.log`);
    }
    break;
  }

  case 'set-key': {
    if (positional[0]) {
      console.error(
        'refusing an API key on the command line: it would be saved in shell history\n' +
          'and briefly visible in the process list.\n\n' +
          'Run `npm run wa -- set-key` for a hidden prompt, or pipe a protected file to it.',
      );
      process.exit(1);
    }
    const key = await readSecret('OpenAI API key (input hidden): ');
    if (!key) {
      console.error('no key received');
      process.exit(1);
    }
    if (!/^sk-[^\s]+$/.test(key)) {
      console.error(`that does not look like an OpenAI key (expected it to start with "sk-")`);
      process.exit(1);
    }
    ensureDataDir();
    writeFileConfig({ openai_api_key: key });
    console.log(`stored ${maskKey(key)} in ${CONFIG_PATH} (mode 0600)`);
    break;
  }

  /*
   * Generate the HTTP bearer token.
   *
   * 32 random bytes, base64url. Printed once here because it has to be pasted
   * into a client, and stored 0600 — but it is never logged by the server itself.
   */
  case 'http-token': {
    const token = randomBytes(32).toString('base64url');
    writeFileConfig({ http_token: token });
    console.log(token);
    console.error(
      `\nstored in ${CONFIG_PATH} (0600).\n` +
        `This token grants full read access to your entire WhatsApp history.\n` +
        `Treat it like a password, not an API key.`,
    );
    break;
  }

  /*
   * Print the current public tunnel URL.
   *
   * A Cloudflare quick tunnel mints a new random hostname on every reconnect and
   * announces it only in its own log, so without this the URL is effectively
   * unfindable after the terminal that started it is gone.
   */
  case 'url': {
    const logPath = join(DATA_DIR, 'logs', 'tunnel.log');
    if (!existsSync(logPath)) {
      console.error(`no tunnel log at ${logPath} — is the tunnel running?`);
      console.error('  launchctl print gui/$(id -u)/com.whatmcp.tunnel | head');
      process.exit(1);
    }
    const found = readFileSync(logPath, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (!found?.length) {
      console.error('no URL in the tunnel log yet; give it a few seconds and retry.');
      process.exit(1);
    }
    // Last wins: earlier entries are hostnames from previous reconnects.
    const url = found[found.length - 1];
    console.log(`${url}/mcp`);
    console.error(
      `\nAuthorization: Bearer <token from ~/.whatmcp/config.json>\n` +
        `This URL is public. The token is the only thing protecting the archive.`,
    );
    break;
  }

  /*
   * Inspect and revoke OAuth grants.
   *
   * Worth having as a first-class command: dynamic client registration means
   * clients appear without you typing anything, so the only way to know who holds
   * a live token is to ask.
   */
  case 'oauth': {
    const sub = positional[0] ?? 'list';
    if (sub === 'revoke') {
      const target = positional[1];
      const n = revokeClient(target);
      console.log(
        target
          ? `revoked ${n} token(s) for ${target}`
          : `revoked ${n} token(s) across all clients`,
      );
      console.log('restart the server so cached handles drop the revocations:');
      console.log('  launchctl kickstart -k gui/$(id -u)/com.whatmcp.server');
      break;
    }
    const clients = listClients();
    if (clients.length === 0) {
      console.log('no OAuth clients registered yet');
      break;
    }
    for (const c of clients) {
      console.log(
        `${c.client_id}  ${String(c.name).padEnd(24)}  ` +
          `${c.active} live token(s)  registered ${fmtTs(Math.floor(c.created_at / 1000))}`,
      );
    }
    console.log('\nrevoke:  npm run wa -- oauth revoke [client_id]');
    break;
  }

  case 'index': {
    const cfg = loadConfig();
    const t0 = Date.now();
    const r = runIndex(cfg.store, {
      chatstorage: cfg.chatstorage,
      full: flag('full'),
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(
      `${r.fullPass ? 'full' : 'incremental'} pass: scanned ${r.scanned}, ` +
        `${r.newMessages} new, ${r.updatedMessages} updated\n` +
        `  ${r.windowsBuilt} window(s) built, ${r.windowsDropped} replaced\n` +
        `  ${r.totalMessages} message(s) archived, watermark Z_PK=${r.watermark}\n` +
        `  ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${cfg.store}`,
    );
    break;
  }

  case 'embed': {
    const cfg = loadConfig();
    const ec = embedConfig(cfg);
    const limit = flagValue('limit');
    await embedMissing(cfg.store, ec, {
      onProgress,
      limit: limit ? Number(limit) : undefined,
      batchSize: Number(flagValue('batch', '128')),
    });
    const db = openStore(cfg.store);
    const cov = vectorCoverage(db, ec);
    db.close();
    console.log(`  coverage: ${cov.embedded}/${cov.windows} (${cov.pct}%)`);
    await calibrateIfUnset(cfg, cov.embedded);
    break;
  }

  case 'sync': {
    const cfg = loadConfig();
    // Fail before touching WhatsApp if the key is missing: a sync that indexes
    // but cannot embed leaves the archive in a half-updated state that looks fine
    // until someone runs a semantic query.
    const ec = embedConfig(cfg);
    const t0 = Date.now();
    console.log(bold('indexing'));
    const r = runIndex(cfg.store, {
      chatstorage: cfg.chatstorage,
      full: flag('full'),
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(
      `  ${r.newMessages} new, ${r.updatedMessages} updated, ` +
        `${r.windowsBuilt} window(s) built  (${r.totalMessages} archived)`,
    );
    console.log(bold('embedding'));
    await embedMissing(cfg.store, ec, { onProgress });
    const db = openStore(cfg.store);
    const cov = vectorCoverage(db, ec);
    db.close();
    console.log(`  coverage: ${cov.embedded}/${cov.windows} (${cov.pct}%)`);
    await calibrateIfUnset(cfg, cov.embedded);
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    break;
  }

  case 'search': {
    const q = positional.join(' ');
    if (!q) {
      console.error('usage: npm run wa -- search <query> [--mode=hybrid|bm25|vector]');
      process.exit(1);
    }
    const out = await searchHybrid(ctx(), {
      query: q,
      mode: flagValue('mode', 'hybrid') as any,
      thread: flagValue('chat'),
      sender: flagValue('sender'),
      limit: Number(flagValue('limit', '10')),
      minSim: loadConfig().minSim,
      strongSim: loadConfig().strongSim,
    });
    if (out.degraded) console.log(dim(`! ${out.degraded}`));
    if (out.hits.length === 0) {
      console.log('no matches');
      break;
    }
    console.log(
      dim(`${out.hits.length} result(s), ${out.strongCount} strong\n`),
    );
    for (const h of out.hits) {
      const prov =
        `bm25 ${h.bm25_rank ?? '-'} | vec ${h.vec_rank ?? '-'}` +
        (h.vec_sim != null ? ` (${h.vec_sim.toFixed(3)})` : '') +
        ` | cov ${(h.term_coverage ?? 0).toFixed(2)}`;
      console.log(
        `${bold(h.thread_title ?? h.thread_id)}  ${fmtTs(h.start_ts)}  ` +
          (h.strong ? '\x1b[32mstrong\x1b[0m' : '\x1b[33mweak\x1b[0m'),
      );
      console.log(dim(`  ${prov}`));
      console.log(h.text.split('\n').map((l) => '  ' + l).join('\n') + '\n');
    }
    break;
  }

  case 'chats': {
    for (const t of listThreads(ctx(), { query: positional.join(' ') || undefined, limit: 40 })) {
      console.log(
        `${String(t.msg_count).padStart(6)}  ${fmtTs(t.last_ts)}  ` +
          `${t.kind.padEnd(5)}  ${t.title ?? t.id}`,
      );
    }
    break;
  }

  case 'people': {
    for (const p of listPeople(ctx(), { query: positional.join(' ') || undefined, limit: 40 })) {
      console.log(
        `${String(p.msg_count).padStart(6)}  ${(p.display_name ?? p.sender_id).padEnd(28)}  ` +
          `${p.thread_count} chat(s)  ${fmtTs(p.first_ts).slice(0, 10)}..${fmtTs(p.last_ts).slice(0, 10)}`,
      );
    }
    break;
  }

  case 'conversation': {
    const [thread, around] = positional;
    if (!thread) {
      console.error('usage: npm run wa -- conversation <thread_id> [iso-date]');
      process.exit(1);
    }
    const at = around ? Math.floor(new Date(around).getTime() / 1000) : undefined;
    for (const m of getConversation(ctx(), { thread_id: thread, around_ts: at, limit: 80 })) {
      console.log(`[${fmtTs(m.ts)}] ${m.sender_name}: ${m.text ?? `<${m.kind}>`}`);
    }
    break;
  }

  case 'doctor': {
    const cfg = loadConfig();
    console.log(bold('config'));
    console.log(`  file:        ${CONFIG_PATH}${existsSync(CONFIG_PATH) ? '' : '  (absent)'}`);
    console.log(`  openai key:  ${maskKey(cfg.openaiKey)}`);
    console.log(`  model:       ${cfg.openaiModel} @ ${cfg.openaiDims} dims`);
    console.log(
      `  thresholds:  min_sim ${cfg.minSim ?? 'default'}, strong_sim ${cfg.strongSim ?? 'default'}` +
        (cfg.strongSim === undefined ? dim('   (run: npm run wa -- calibrate)') : ''),
    );

    console.log(bold('\nenvironment'));
    let blocked = false;
    for (const c of runPreflight(cfg.chatstorage)) {
      console.log(`  ${c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.label}: ${c.detail}`);
      if (!c.ok && c.fix) {
        console.log(c.fix.split('\n').map((l) => '      ' + l).join('\n'));
        blocked = true;
      }
    }

    const src = wa.sourceInfo(cfg.chatstorage);
    if (src.exists && !blocked) {
      console.log(`  path:    ${cfg.chatstorage}`);
      console.log(`  size:    ${fmtBytes(src.size)}, modified ${fmtTs(src.mtime)}`);
      let snap: string | null = null;
      try {
        snap = wa.snapshot(cfg.chatstorage);
        const counts = wa.sourceCounts(snap);
        console.log(`  content: ${counts.messages} message(s), max Z_PK ${counts.maxPk}`);
      } catch (e) {
        console.log(`  content: \x1b[31munreadable\x1b[0m — ${(e as Error).message}`);
      } finally {
        // snapshot() copies ~100 MB into a temp dir; doctor gets run repeatedly
        // while troubleshooting, so leaving them behind would fill /tmp.
        if (snap) rmSync(dirname(snap), { recursive: true, force: true });
      }
    }

    console.log(bold('\nbackground agents'));
    for (const label of ['com.whatmcp.sync', 'com.whatmcp.server', 'com.whatmcp.tunnel']) {
      let state = 'not installed';
      try {
        const out = execFileSync('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${label}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        // Match to end of line: launchd says "not running", and \w+ silently
        // truncates that to "not", which reads as a different state entirely.
        state = /state = (.+)/.exec(out)?.[1]?.trim() ?? 'loaded';
      } catch { /* not loaded */ }
      console.log(`  ${label.padEnd(20)} ${state}`);
    }
    const iv = loadConfig().syncIntervalHours;
    console.log(`  sync cadence:        ${iv ? iv + 'h' : 'manual only'}`);

    console.log(bold('\narchive'));
    if (!existsSync(cfg.store)) {
      console.log(`  none yet at ${cfg.store}`);
      console.log('  build it:  npm run sync');
    } else {
      const s = stats(ctx());
      console.log(`  path:      ${cfg.store} (${fmtBytes(statSync(cfg.store).size)})`);
      console.log(`  messages:  ${s.messages}`);
      console.log(`  chats:     ${s.threads}`);
      console.log(`  people:    ${s.senders}`);
      console.log(`  windows:   ${s.windows}`);
      console.log(
        `  embedded:  ${s.embedded}/${s.windows} ` +
          `(${s.windows ? Math.round((s.embedded / s.windows) * 100) : 0}%) with ${s.model}`,
      );
      console.log(`  range:     ${fmtTs(s.earliest)} .. ${fmtTs(s.latest)}`);
      console.log(`  last sync: ${fmtTs(s.last_sync_at)}`);
    }
    break;
  }

  /*
   * Fit the similarity thresholds to THIS corpus and THIS model.
   *
   * Cosine similarity carries no absolute meaning across models: an E5 model puts
   * unrelated text near 0.75, text-embedding-3-small near 0.10. Hard-coding either
   * number breaks the other. Worse, it breaks quietly — too high a floor returns
   * nothing from the vector arm and search degrades to keyword-only while still
   * reporting results.
   *
   * The method needs no labelled data: embed queries about subjects guaranteed to
   * be absent from a personal chat history, and measure how similar the corpus's
   * *best* match to that nonsense is. That is the noise ceiling. A real hit scoring
   * above it is evidence; anything below the nonsense mid-field is not worth
   * returning at all.
   */
  case 'calibrate': {
    const cfg = loadConfig();
    const ec = embedConfig(cfg);
    const store = getStore(cfg.store, modelTag(ec));
    if (!store.vectors) {
      console.error('no vectors in the archive yet — run: npm run wa -- sync');
      process.exit(1);
    }

    console.log(
      `probing ${store.vectors.n} vectors with ${NOISE_PROBES.length} out-of-domain queries…`,
    );
    const result = await calibrateThresholds(cfg, {
      onProbe: (q, top1, p100) =>
        console.log(`  ${top1.toFixed(3)}  ${dim(p100.toFixed(3))}  ${q}`),
    });
    if (!result) {
      console.error('every probe came back empty — nothing to calibrate against');
      process.exit(1);
    }

    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(
      `\nnoise top-1:  max ${Math.max(...result.top1).toFixed(3)}  ` +
        `mean ${mean(result.top1).toFixed(3)}\n` +
        `noise top-100: mean ${mean(result.p100).toFixed(3)}\n\n` +
        `strong_sim -> ${result.strong}   (a hit above this beats anything nonsense retrieved)\n` +
        `min_sim    -> ${result.minSim}   (floor; only drops the pathological tail)`,
    );
    console.log(`\nwritten to ${CONFIG_PATH}`);
    break;
  }

  default:
    console.log(`WhatMCP — local MCP server over your WhatsApp history

  setup                     guided first-run: key, index, embed, periodic sync
  sync-every <hours>        background sync cadence (0 disables)
  set-key                   securely prompt for the OpenAI API key (0600)
  http-token                generate the HTTP bearer token (for npm run serve:http)
  url                       print the current public tunnel URL
  oauth [revoke <id>]       list or revoke OAuth clients
  sync [--full]             index new messages, then embed anything missing
  index [--full]            index only
  embed [--limit=N]         embed only
  calibrate                 fit similarity thresholds to this corpus
  doctor                    config, source readability, archive coverage

  search <query>            [--mode=hybrid|bm25|vector] [--chat=] [--sender=]
  chats [filter]            chats by recency
  people [filter]           people by message volume
  conversation <id> [date]  dump one thread

data dir: ${DATA_DIR}`);
}

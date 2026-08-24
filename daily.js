#!/usr/bin/env node
// ---------------------------------------------------------------------------
// daily.js — the nightly automation daemon.
//
// Replaces "open the scraper extension and click Run every night" with an
// unattended process that, in USA time (SCHEDULE_TZ):
//
//   • 23:30 — flush every scraper store's staging → leads collection, exactly
//     as the old server's daily cron did (per-store /api/flush-staging).
//   • 00:00 — the date has changed: run the full scrape for every scraper
//     account, one after another. For each store:
//         gameplan.users (role:'scraper') → decrypt CRM creds → dedicated proxy
//         → login to Unify → Modern Retail CRM → desklog pipeline (multi-tab,
//         all features) → markScrapeDone → next store.
//
// Run it:
//   npm run daily                 start the daemon (schedules both jobs)
//   npm run scrape-now            run the 00:00 scrape immediately, then exit
//   npm run flush-now             run the 23:30 flush immediately, then exit
//   node daily.js --store <id>    run a single store now, then exit
//
// The launch system in src/browser.js is untouched: each store just launches
// through openBrowser with its allocator-chosen proxy.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { FLUSH_AT, SCRAPE_AT, SCHEDULE_TZ, STORE_CONCURRENCY } from "./src/config.js";
import { getScraperAccounts, close as mongoClose } from "./src/store/mongo.js";
import { resolveCredentials } from "./src/store/credentials.js";
import { mintAccessToken } from "./src/scrape/gpAuth.js";
import { ApiClient } from "./src/scrape/api.js";
import { runStore } from "./src/scrape/runStore.js";
import { scheduleDaily } from "./src/scrape/scheduler.js";

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`${ts()} ${msg}`);

// ── 23:30 job — flush staging → leads for every scraper store ───────────────
// The /api/flush-staging endpoint is per-store (scoped by the caller's token),
// so we mint a token per account and call it once each. Mirrors the old
// server-side flushAllStores cron, just driven from here.
async function flushAllStores() {
  log("🧹 Nightly flush: staging → leads for every scraper store");
  let accounts = [];
  try {
    accounts = await getScraperAccounts();
  } catch (err) {
    log(`  ✖ could not load scraper accounts: ${err.message}`);
    return;
  }

  let ok = 0;
  let fail = 0;
  let moved = 0;
  for (const user of accounts) {
    const tag = user.name || user.store_id || user.email || "store";
    if (!user.store_id || !user.corporate_id) {
      log(`  – ${tag}: no store/corporate — skip`);
      continue;
    }
    try {
      const api = ApiClient.fromToken(mintAccessToken(user), {
        store_id: user.store_id,
        corporate_id: user.corporate_id,
        role: user.role || "scraper",
      });
      const res = await api.flushStaging();
      const m = (res && res.moved) || 0;
      moved += m;
      ok++;
      log(`  ✓ ${tag}: moved ${m}`);
    } catch (err) {
      fail++;
      log(`  ✖ ${tag}: ${err.message}`);
    }
  }
  log(`🧹 Flush done: ${ok} ok, ${fail} failed, ${moved} lead(s) moved total`);
}

// ── 00:00 job — scrape scraper accounts, up to STORE_CONCURRENCY at a time ──
async function scrapeAllStores(config = {}, concurrency = STORE_CONCURRENCY) {
  log("🚀 Nightly scrape: running every scraper account");
  let accounts = [];
  try {
    accounts = await getScraperAccounts();
  } catch (err) {
    log(`  ✖ could not load scraper accounts: ${err.message}`);
    return;
  }

  // Drop accounts with no CRM login before launching anything.
  const runnable = [];
  const summary = { ran: 0, skipped: 0, failed: 0 };
  for (const user of accounts) {
    const tag = user.name || user.store_id || user.email || "store";
    if (!resolveCredentials(user)) {
      log(`⏭  ${tag}: no CRM credentials — skip`);
      summary.skipped++;
    } else {
      runnable.push(user);
    }
  }

  const lanes = Math.max(1, Math.min(concurrency, runnable.length));
  log(`Found ${accounts.length} account(s): ${runnable.length} runnable, ${summary.skipped} skipped`);
  log(`Running ${lanes} store(s) concurrently (STORE_CONCURRENCY=${concurrency})`);

  // Simple worker pool: each lane pulls the next store off a shared cursor, so
  // a slow store never blocks the others and all lanes stay busy.
  let cursor = 0;
  const started = Date.now();
  const lane = async (laneId) => {
    while (true) {
      const i = cursor++;
      if (i >= runnable.length) return;
      const user = runnable[i];
      const tag = user.name || user.store_id || "store";
      log(`──── [lane ${laneId}] ${tag}  (${i + 1}/${runnable.length}) ────`);
      try {
        const r = await runStore(user, {
          config,
          onLog: (m) => console.log(`${ts()} ${m}`),
        });
        if (r.ok) summary.ran++;
        else if (r.skipped) summary.skipped++;
        else summary.failed++;
      } catch (err) {
        summary.failed++;
        log(`✖ ${tag}: unhandled — ${err.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i + 1)));

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  log(`🏁 Scrape run complete in ${mins} min: ${summary.ran} ran, ${summary.skipped} skipped, ${summary.failed} failed`);
}

// ── One store by id (debug) ─────────────────────────────────────────────────
// Run one store and report success via the process exit code, so an external
// orchestrator (AWS Batch / Step Functions / a user-data script) can tell a
// completed scrape from a failed one:
//   0 = scraped successfully
//   2 = skipped (no CRM credentials / not found) — not an error, but nothing ran
//   1 = failed
async function scrapeOneStore(storeId, config = {}) {
  const accounts = await getScraperAccounts();
  const user = accounts.find((u) => String(u.store_id) === String(storeId));
  if (!user) {
    log(`No active scraper account with store_id=${storeId}`);
    return 2;
  }
  const r = await runStore(user, { config, onLog: (m) => console.log(`${ts()} ${m}`) });
  if (r && r.ok) return 0;
  if (r && r.skipped) return 2;
  return 1;
}

// ── entry ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { config: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--flush-now") out.flushNow = true;
    else if (a === "--scrape-now") out.scrapeNow = true;
    else if (a === "--store") out.store = argv[++i];
    else if (a === "--date") out.config.targetDate = argv[++i];
    else if (a === "--recon-start") out.config.reconStartDate = argv[++i];
    else if (a === "--skip-sold-recon") out.config.skipSoldRecon = true;
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  // One-shot modes exit when done.
  if (args.store) {
    const code = await scrapeOneStore(args.store, args.config)
      .catch((err) => { log(`Fatal: ${err.message}`); return 1; })
      .finally(() => mongoClose());
    log(`Exiting with code ${code}`);
    process.exit(code);
  }
  if (args.flushNow) {
    await flushAllStores().finally(() => mongoClose());
    return;
  }
  if (args.scrapeNow) {
    await scrapeAllStores(args.config, args.concurrency || STORE_CONCURRENCY).finally(() => mongoClose());
    return;
  }

  // Daemon mode: schedule both jobs and stay resident.
  log(`Daemon starting. Timezone ${SCHEDULE_TZ}. Flush ${FLUSH_AT}, scrape ${SCRAPE_AT}, concurrency ${STORE_CONCURRENCY}.`);
  const flushJob = scheduleDaily(FLUSH_AT, flushAllStores, { onLog: log });
  const scrapeJob = scheduleDaily(SCRAPE_AT, () => scrapeAllStores(), { onLog: log });

  // Keep the process alive (the schedule timers are unref'd).
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = async (sig) => {
    log(`${sig} received — shutting down.`);
    flushJob.cancel();
    scrapeJob.cancel();
    clearInterval(keepAlive);
    await mongoClose();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
#!/usr/bin/env node
// ---------------------------------------------------------------------------
// demo/flow-demo.js — WATCH THE NIGHTLY FLOW, offline.
//
// This does NOT touch your real Mongo, CRM, or backends. It reproduces exactly
// the sequence daily.js → runStore.js → pipeline.js would execute, so you can
// see how accounts are picked and processed one by one.
//
// What is REAL here (your actual shipped code, unchanged):
//   • src/store/credentials.js  — the Fernet decryption of each CRM password
//   • src/scrape/gpAuth.js       — the self-minted HS256 access token
//   • the proxy rules            — same 4 rules as src/store/proxyAllocator.js
//
// What is SIMULATED (because this sandbox has no Mongo/Chrome/network to them):
//   • the account list           — 3 sample scraper docs (like gameplan.users)
//   • the browser                — no Chrome launch; login steps are narrated
//   • the two backends           — calls are narrated with plausible counts
//
// Run:  node demo/flow-demo.js
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// A demo Fernet key + JWT secret. Set BEFORE importing the real modules, since
// config.js reads them at import time. These are throwaway demo values.
const DEMO_FERNET_KEY = crypto.randomBytes(32).toString("base64url"); // 32-byte urlsafe key
const DEMO_JWT_SECRET = "demo-jwt-secret-only-for-this-simulation-000000000000000000000000";
process.env.ELEAD_CRED_KEY = DEMO_FERNET_KEY;
process.env.JWT_SECRET = DEMO_JWT_SECRET;

// Import the REAL modules (they now see the demo env).
const { resolveCredentials } = await import(path.join(ROOT, "src/store/credentials.js"));
const { mintAccessToken } = await import(path.join(ROOT, "src/scrape/gpAuth.js"));

// ── tiny helpers ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const log = async (msg, ms = 180) => { console.log(`${ts()}  ${msg}`); await sleep(ms); };
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Fernet ENCRYPT (so the REAL resolveCredentials can decrypt it live). Mirrors
// the token format credentials.js verifies: 0x80 | ts | IV | ct | HMAC.
function fernetEncrypt(plaintext, keyB64url) {
  const key = Buffer.from(keyB64url, "base64url");
  const signKey = key.subarray(0, 16);
  const encKey = key.subarray(16, 32);
  const iv = crypto.randomBytes(16);
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const cipher = crypto.createCipheriv("aes-128-cbc", encKey, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const parts = Buffer.concat([Buffer.from([0x80]), tsBuf, iv, ct]);
  const hmac = crypto.createHmac("sha256", signKey).update(parts).digest();
  return Buffer.concat([parts, hmac]).toString("base64url");
}

// ── sample accounts (shaped like gameplan.users, role:'scraper') ────────────
// #1 decrypts + runs a full pipeline.
// #2 decrypts, but its first proxy "blocks" → retire + rebind → retry succeeds.
// #3 has NO CRM password → skipped before any browser launch.
const ACCOUNTS = [
  {
    _id: "6a4539754276fc56aad97329",
    name: "DCJR Scraper",
    email: "dcjrsherscraper@fletcher",
    role: "scraper",
    active: true,
    store_id: "6a452e134276fc56aad97326",
    corporate_id: "69f9b6c85de85ca1bebb8d26",
    elead_email: "fletchersherwood158@gmail.com",
    elead_key_source: "env",
    elead_password_enc: fernetEncrypt("demo-DCJR-crm-pass", DEMO_FERNET_KEY),
    __sim: { block: false },
  },
  {
    _id: "7b1122334455667788990011",
    name: "Ford Store Scraper",
    email: "fordscraper@fletcher",
    role: "scraper",
    active: true,
    store_id: "7b452e134276fc56aad00777",
    corporate_id: "69f9b6c85de85ca1bebb8d26",
    elead_email: "fordscraper158@gmail.com",
    elead_key_source: "env",
    elead_password_enc: fernetEncrypt("demo-FORD-crm-pass", DEMO_FERNET_KEY),
    __sim: { block: true }, // first proxy will be simulated as blocked
  },
  {
    _id: "9c9988776655443322110099",
    name: "Kia Scraper",
    email: "kiascraper@fletcher",
    role: "scraper",
    active: true,
    store_id: "9c452e134276fc56aad00888",
    corporate_id: "69f9b6c85de85ca1bebb8d26",
    elead_email: "", // no CRM login on file → skipped
    elead_key_source: "env",
    elead_password_enc: "",
    __sim: {},
  },
];

// ── proxy pool + in-memory bindings (mirrors src/store/proxyAllocator.js) ────
function loadPool() {
  const file = path.join(ROOT, "proxies.txt");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [host, port] = l.split(":");
      return { host, port: Number(port) };
    })
    .filter((e) => e.host && e.port);
}
const POOL = loadPool();
const bindings = new Map(); // store_id → { host, port, retiredAt? }

function keyOf(h, p) { return `${h}:${p}`; }
function takenByOthers(storeId) {
  const taken = new Set();
  for (const [sid, b] of bindings) {
    if (sid !== storeId && b && !b.retiredAt) taken.add(keyOf(b.host, b.port));
  }
  return taken;
}
// Same decision tree as the real resolveProxyForAccount.
async function resolveProxy(storeId, logln) {
  if (!POOL.length) { await logln("  ⚠ no proxies configured — would run direct"); return null; }
  const inPool = (h, p) => POOL.find((e) => e.host === h && e.port === Number(p));
  const b = bindings.get(storeId);
  if (b && !b.retiredAt) {
    const still = inPool(b.host, b.port);
    if (still) { await logln(`  🔗 rule 1: reuse pinned proxy ${still.host}:${still.port}`); return still; }
    await logln(`  🔁 rule 4: pinned ${b.host}:${b.port} left the pool — rebinding`);
  } else if (b && b.retiredAt) {
    await logln(`  ♻  rule 2: previous proxy was retired — assigning fresh`);
  }
  const taken = takenByOthers(storeId);
  const free = POOL.filter((e) => !taken.has(keyOf(e.host, e.port)));
  if (!free.length) { await logln(`  ⚠ rule 3: no free IP — every pool entry is held by another live account`); return null; }
  const chosen = free[0];
  bindings.set(storeId, { host: chosen.host, port: chosen.port });
  await logln(`  🆕 rule 3: newly bound proxy ${chosen.host}:${chosen.port}`);
  return chosen;
}
function retireProxy(storeId) {
  const b = bindings.get(storeId);
  if (b) { b.retiredAt = new Date(); bindings.set(storeId, b); }
}

// ── simulated browser + pipeline (same phase names as the real code) ────────
async function simulateEnterCrm(acct, proxy, attempt) {
  const L = (m, ms) => log(`    ${m}`, ms);
  await L(`🌐 launching Chrome via puppeteer-real-browser${proxy ? ` (proxy ${proxy.host}:${proxy.port})` : " (direct)"}`, 250);
  // Simulated proxy block on the first attempt for the flagged account.
  if (acct.__sim.block && attempt === 1) {
    await L(`🔎 opening Unify → login host`, 200);
    await L(`❌ navigation blocked (looks like the proxy IP is challenged: 403)`, 200);
    throw new Error("navigation blocked (403 challenge) — proxy");
  }
  const restored = Math.random() > 0.5;
  await L(restored ? "🍪 restored 14 cookies from Mongo (crm_sessions)" : "🍪 no saved session — will sign in", 200);
  await L("🔐 opening Unify: https://app-unify.app.connectcdk.com/applications", 250);
  if (restored) await L("✅ saved session accepted — already signed in", 200);
  else {
    await L(`⌨  filling #emailId = ${acct.elead_email}`, 200);
    await L("⌨  filling #password = •••••••••", 150);
    await L("🖱  click [data-testid=primary-button] → leaving login host", 250);
    await L("✅ signed in", 150);
  }
  await L('🖱  click [data-testid="card-modern-retail-crm"] → Modern Retail CRM', 250);
  await L("✅ inside eLead (crm.connectcdk.com) — index.aspx", 200);
  return { loggedIn: true };
}

async function simulatePipeline(acct) {
  const L = (m, ms) => log(`    ${m}`, ms);
  const isoY = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  await L(`📅 target date ${isoY}`, 200);
  await L("🧹 cleared daily_urls for this store", 180);
  await L("📊 Report A: Lead Source Stats (id=1829)", 220);
  const srcRows = rint(6, 12);
  await L(`   ✓ parsed ${srcRows} source rows; walking Good Leads / Appts Due / Appts Shown / Sold drilldowns`, 260);
  const aLeads = rint(8, 20);
  await L(`   🔗 discovered ${aLeads} unique lead URLs → saved to daily_urls`, 240);
  await L("🏟️  Showroom-Up report (id=251 → id=1987 drilldowns)", 240);
  const shLeads = rint(3, 9);
  await L(`   🔗 Showroom discovery: ${shLeads} lead URLs`, 220);
  const notSold = rint(2, 7);
  await L(`   🚶 store visits (Visits − Sold): ${notSold} not-yet-sold walk-ins saved`, 220);
  await L("🧮 Sold reconciliation (month-to-date, co-buyer de-duped)", 220);
  const reconQ = rint(0, 4);
  await L(`   queued ${reconQ} missing sold deal(s)`, 200);

  const total = aLeads + shLeads + reconQ;
  await L(`🧑‍💻 Phase 2: scraping ${total} leads across 5 worker tabs`, 260);
  let saved = 0, failed = 0;
  const names = ["A. Johnson", "M. Patel", "R. Nguyen", "T. Garcia", "K. Smith", "L. Brown", "D. Wilson", "S. Davis"];
  for (let i = 0; i < Math.min(total, 6); i++) {
    const w = i % 5;
    if (Math.random() > 0.12) { saved++; await L(`   W${w}: ✅ ${names[i % names.length]}`, 90); }
    else { failed++; await L(`   W${w}: ❌ ${names[i % names.length]} (timeout)`, 90); }
  }
  if (total > 6) { saved += total - 6 - rint(0, 1); await L(`   … ${total - 6} more`, 140); }
  await L(`   ✓ lead scrape: ${saved} saved, ${failed} failed`, 200);

  await L("🔁 Rechecks across 5 tabs", 220);
  const rSaved = rint(3, 10);
  await L(`   🔁 rechecks done — saved ${rSaved}`, 200);

  await L("🤖 markScrapeDone → POST /api/agent/scrape-done (arms the 10-min agent timer)", 240);
  await L("💾 session re-saved to Mongo (one doc, updated in place)", 180);
  return { saved, failed, reconQ, rSaved };
}

// ── the driver: mirrors daily.js::scrapeAllStores ───────────────────────────
async function main() {
  console.log("=".repeat(74));
  console.log("  GAME PLAN — nightly scrape flow (SIMULATION, no live Mongo/CRM/Chrome)");
  console.log("=".repeat(74));
  await log(`Proxy pool: ${POOL.length} IP(s) from proxies.txt`, 150);
  await log(`Discovered ${ACCOUNTS.length} active scraper account(s) in gameplan.users`, 300);

  const summary = { ran: 0, skipped: 0, failed: 0 };

  for (const acct of ACCOUNTS) {
    console.log("");
    console.log("─".repeat(74));
    await log(`▶  STORE: ${acct.name}  (store_id=${acct.store_id})`, 150);
    console.log("─".repeat(74));

    // 1) credentials (REAL decryption)
    const creds = resolveCredentials(acct);
    if (!creds) {
      await log(`  ⏭  no CRM email/password on file — SKIP (no browser launched)`, 220);
      summary.skipped++;
      continue;
    }
    await log(`  🔓 decrypted CRM login (real Fernet): ${creds.username}  /  ${"•".repeat(creds.password.length)}`, 220);

    // 2) access token (REAL mint)
    const token = mintAccessToken(acct);
    await log(`  🎟  minted HS256 access token (sub/role/store_id/corporate_id) — ${token.slice(0, 24)}…`, 200);

    // 3) proxy → launch → login → pipeline, with one block-retry
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      if (attempt === 2) await log(`  🔁 retrying on a fresh IP after proxy block`, 180);
      const proxy = await resolveProxy(acct.store_id, (m) => log(m, 160));
      try {
        await simulateEnterCrm(acct, proxy, attempt);
        const r = await simulatePipeline(acct);
        await log(`  🏁 ${acct.name} done — leads ${r.saved}, rechecks ${r.rSaved}, recon ${r.reconQ}, failed ${r.failed}`, 200);
        ok = true;
        summary.ran++;
      } catch (err) {
        await log(`  ⚠ attempt ${attempt} failed: ${err.message}`, 160);
        if (/proxy|403|429|timeout|navigation|blocked|net::/i.test(err.message) && attempt === 1) {
          await log(`  ♻  retiring IP (frees it for reuse per rule 2) and rebinding`, 180);
          retireProxy(acct.store_id);
        } else {
          summary.failed++;
          await log(`  ✖ giving up on ${acct.name} for tonight`, 160);
          break;
        }
      }
    }
  }

  console.log("");
  console.log("=".repeat(74));
  await log(`🏁 RUN COMPLETE — ${summary.ran} ran, ${summary.skipped} skipped, ${summary.failed} failed`, 0);
  console.log("=".repeat(74));
  console.log("");
  console.log("This was a simulation. To run it for real, on a machine with Chrome +");
  console.log("network access to your Mongo/CRM/backends:");
  console.log("    npm install");
  console.log("    cp .env.example .env   # fill MONGO_URI, JWT_SECRET, proxies, …");
  console.log("    npm run scrape-now     # runs this exact flow against live data");
  console.log("    npm run daily          # or leave it resident: 23:30 flush + 00:00 scrape");
}

main().catch((e) => { console.error(e); process.exit(1); });

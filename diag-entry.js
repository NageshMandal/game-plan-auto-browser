#!/usr/bin/env node
// ---------------------------------------------------------------------------
// diag-entry.js — find out EXACTLY what happens when we click the CRM card.
//
// This does not scrape. It logs in as one store, clicks the Modern Retail CRM
// card, then watches the browser for 45 seconds and reports:
//
//   • every frame URL, every 3s (does the app frame ever leave sso.html?)
//   • every network request to Okta / crm.connectcdk.com (does SSO run at all?)
//   • the final cookie count for crm.connectcdk.com (did a session get minted?)
//
// It leaves the browser OPEN at the end so you can look at it and click around.
//
// Run:
//   node diag-entry.js                 # first scraper account with CRM creds
//   node diag-entry.js --store <id>    # a specific store
//   node diag-entry.js --no-proxy      # bypass the proxy (isolates proxy issues)
// ---------------------------------------------------------------------------
import "dotenv/config";
import { UNIFY_APP_URL, CRM_HOST, MODERN_RETAIL_CRM_CARD_SELECTORS } from "./src/config.js";
import { getScraperAccounts, close as mongoClose } from "./src/store/mongo.js";
import { resolveCredentials } from "./src/store/credentials.js";
import { resolveProxyForAccount } from "./src/store/proxyAllocator.js";
import { openBrowser } from "./src/browser.js";
import { restoreSession } from "./src/scrape/session.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 23);
const log = (m) => console.log(`${ts()}  ${m}`);

const args = process.argv.slice(2);
const wantStore = args.includes("--store") ? args[args.indexOf("--store") + 1] : null;
const noProxy = args.includes("--no-proxy");

async function main() {
  const accounts = await getScraperAccounts();
  const usable = accounts.filter((a) => resolveCredentials(a) && a.store_id);
  const user = wantStore
    ? usable.find((a) => String(a.store_id) === String(wantStore))
    : usable[0];
  if (!user) { log("No usable scraper account found."); return; }
  const creds = resolveCredentials(user);
  log(`Store: ${user.name} (${user.store_id})  CRM user: ${creds.username}`);

  const proxy = noProxy ? null : await resolveProxyForAccount(user.store_id, log);
  log(proxy ? `Proxy: ${proxy.host}:${proxy.port}` : "Proxy: DIRECT (no proxy)");

  const { browser, page } = await openBrowser({
    profile: `diag-${user.store_id}`,
    onStage: log,
    proxyOverride: proxy || undefined,
    noProxy: !proxy,
  });

  // ── network watch ────────────────────────────────────────────────────────
  const seen = { okta: 0, crm: 0, samlUrls: [], crmUrls: [] };
  page.on("request", (r) => {
    let u = "";
    try { u = r.url(); } catch { return; }
    if (/okta\.com/i.test(u)) {
      seen.okta++;
      if (/sso\/saml/i.test(u) && seen.samlUrls.length < 3) {
        seen.samlUrls.push(u);
        log(`NET  SAML → ${u.slice(0, 130)}`);
      }
    }
    if (u.includes(CRM_HOST)) {
      seen.crm++;
      if (seen.crmUrls.length < 6) {
        seen.crmUrls.push(u);
        log(`NET  CRM  → ${u.slice(0, 130)}`);
      }
    }
  });

  await restoreSession(page, user.store_id, log).catch(() => {});
  log(`Opening ${UNIFY_APP_URL}`);
  await page.goto(UNIFY_APP_URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch((e) => log(`goto: ${e.message}`));
  await sleep(8000);
  log(`Landed on: ${page.url()}`);

  // If a login form is showing, sign in.
  const needsLogin = await page.evaluate(() =>
    !!document.querySelector('#emailId, input[type="password"]')).catch(() => false);
  if (needsLogin) {
    log("Login form present — signing in");
    try {
      await page.type("#emailId", creds.username, { delay: 40 });
      await page.type("#password", creds.password, { delay: 40 });
      await page.click('[data-testid="primary-button"]');
      await sleep(15000);
      log(`After login: ${page.url()}`);
    } catch (e) { log(`login failed: ${e.message}`); }
  } else {
    log("Already signed in");
  }

  // ── the click ────────────────────────────────────────────────────────────
  const before = page.frames().map((f) => f.url());
  log(`Frames BEFORE click (${before.length}):`);
  before.forEach((u) => log(`   ${u.slice(0, 130)}`));

  let handle = null;
  for (const sel of MODERN_RETAIL_CRM_CARD_SELECTORS) {
    handle = await page.$(sel).catch(() => null);
    if (handle) { log(`Card found via ${sel}`); break; }
  }
  if (!handle) { log("!! CARD NOT FOUND — stopping (browser left open)"); return; }

  const box = await handle.boundingBox();
  log(`Card box: ${JSON.stringify(box)}`);
  if (box) {
    const x = box.x + Math.min(box.width * 0.35, box.width - 8);
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 8 });
    await sleep(200);
    await page.mouse.click(x, y, { delay: 60 });
    log(`REAL MOUSE CLICK at (${Math.round(x)}, ${Math.round(y)})`);
  } else {
    await handle.click({ delay: 60 });
    log("element.click() used (no box)");
  }

  // ── watch for 45s ────────────────────────────────────────────────────────
  for (let i = 1; i <= 15; i++) {
    await sleep(3000);
    const urls = page.frames().map((f) => f.url());
    const crmFrames = urls.filter((u) => u.includes(CRM_HOST));
    log(`[t+${i * 3}s] frames=${urls.length} crmFrames=${crmFrames.length} oktaReqs=${seen.okta} crmReqs=${seen.crm} | top=${page.url().slice(0, 80)}`);
    for (const u of crmFrames) log(`        CRM FRAME: ${u.slice(0, 130)}`);
  }

  // ── cookies ──────────────────────────────────────────────────────────────
  try {
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable").catch(() => {});
    const { cookies = [] } = await cdp.send("Network.getAllCookies");
    const crmCookies = cookies.filter((c) =>
      String(c.domain || "").replace(/^\./, "").toLowerCase().includes(CRM_HOST));
    log(`CRM cookies now: ${crmCookies.length} → ${crmCookies.map((c) => c.name).join(", ") || "(none)"}`);
    const okta = cookies.filter((c) => /okta/i.test(c.domain || ""));
    log(`Okta cookies: ${okta.length}`);
  } catch (e) { log(`cookie read failed: ${e.message}`); }

  log("");
  log("VERDICT HINTS:");
  log(`  SAML requests seen: ${seen.samlUrls.length ? "YES" : "NO"}`);
  log(`  CRM requests seen : ${seen.crm > 0 ? "YES" : "NO"}`);
  log("  If both NO → the click is not launching the app.");
  log("  If SAML YES but no CRM frame → SSO is failing partway.");
  log("");
  log("Browser left OPEN. Click the CRM card yourself and watch what happens.");
  log("Press Ctrl+C when done.");
  await new Promise(() => {}); // hold open
}

main().catch((e) => { console.error(e); mongoClose(); process.exit(1); });

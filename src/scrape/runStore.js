// ---------------------------------------------------------------------------
// src/scrape/runStore.js — run the full daily flow for ONE scraper account.
//
// Ties together everything the single-target index.js did, but parameterised
// per store and backed by Mongo instead of the on-disk .session files:
//
//   1. resolveProxyForAccount(store_id)  → the account's dedicated IP (rules in
//      src/store/proxyAllocator.js). null ⇒ run direct / skip per policy.
//   2. openBrowser({ proxyOverride })    → the UNCHANGED launch system, just
//      told which IP to use. We never touch how the browser is launched.
//   3. restoreSession(store_id)          → re-inject saved cookies from Mongo.
//   4. enterCrm(page, credentials)       → Unify login (only if the restored
//      session didn't already land us inside) + click "Modern Retail CRM".
//   5. saveSession(store_id)             → persist refreshed cookies (one doc).
//   6. runStorePipeline(...)             → the ported desklog pipeline; ends by
//      calling markScrapeDone (arms the agent) when anything was saved.
//   7. saveSession again + close browser.
//
// Proxy-blocked handling: if login/entry fails in a way that looks like the IP
// is blocked, we retireProxy(store_id) (freeing the IP for reuse per rule 2),
// reallocate a fresh IP, and retry ONCE. A second failure gives up on the store
// for the night (logged) rather than burning the whole run.
// ---------------------------------------------------------------------------
import { openBrowser } from "../browser.js";
import { resolveProxyForAccount } from "../store/proxyAllocator.js";
import { retireProxy } from "../store/mongo.js";
import { resolveCredentials } from "../store/credentials.js";
import { restoreSession, saveSession } from "./session.js";
import { enterCrm } from "./crmLogin.js";
import { runStorePipeline } from "./pipeline.js";
import { mintAccessToken } from "./gpAuth.js";
import { ApiClient } from "./api.js";
import { sleep } from "./inject.js";

// Heuristic: does an entry failure look like the proxy IP was blocked (vs. bad
// credentials, which retrying on a new IP won't fix)? We only rotate the proxy
// for connection/challenge-type failures.
function looksLikeProxyBlock(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("net::") ||
    m.includes("err_") ||
    m.includes("navigation") ||
    m.includes("blocked") ||
    m.includes("403") ||
    m.includes("429") ||
    m.includes("challenge") ||
    m.includes("access denied") ||
    m.includes("tunnel") ||
    m.includes("proxy")
  );
}

/**
 * Run one store end to end.
 *
 * @param {object} userDoc  a gameplan.users doc (role:'scraper')
 * @param {object} opts
 * @param {object} opts.config  passed through to runStorePipeline
 *                              ({ targetDate?, reconStartDate?, skipSoldRecon? })
 * @param {function} opts.onLog logger (defaults to console)
 * @returns {Promise<{ ok: boolean, skipped?: string, result?: object, error?: string }>}
 */
export async function runStore(userDoc, { config = {}, onLog } = {}) {
  const storeId = userDoc.store_id || "";
  const tag = userDoc.name || storeId || userDoc.email || "store";
  const log = (msg) => (onLog ? onLog(`[${tag}] ${msg}`) : console.log(`[${tag}] ${msg}`));

  // ── Credentials (skip accounts with no usable CRM login, per the brief) ──
  const creds = resolveCredentials(userDoc);
  if (!creds) {
    log("No CRM email/password (or undecryptable) — skipping.");
    return { ok: false, skipped: "no-credentials" };
  }
  if (!storeId || !userDoc.corporate_id) {
    log("Account not linked to a store/corporate — skipping.");
    return { ok: false, skipped: "no-store" };
  }

  // ── Per-store API client: a self-minted HS256 token (no password needed) ──
  let api;
  try {
    api = ApiClient.fromToken(mintAccessToken(userDoc), {
      store_id: storeId,
      corporate_id: userDoc.corporate_id,
      role: userDoc.role || "scraper",
      name: userDoc.name || "",
    });
  } catch (err) {
    log(`Could not mint access token: ${err.message}`);
    return { ok: false, error: "token-mint-failed" };
  }

  // One attempt = allocate proxy → launch → restore → enter CRM → pipeline.
  const attempt = async (isRetry) => {
    const proxy = await resolveProxyForAccount(storeId, log);
    // proxy may be null (no free IP / none configured) → openBrowser runs direct.

    let session;
    try {
      session = await openBrowser({
        profile: `store-${storeId}`,
        onStage: (s) => log(s),
        proxyOverride: proxy || undefined,
        noProxy: !proxy,
      });
    } catch (err) {
      throw Object.assign(new Error(`browser launch failed: ${err.message}`), { proxy });
    }

    const { browser, page } = session;
    try {
      // Restore cookies from Mongo BEFORE the first navigation.
      const restored = await restoreSession(page, storeId, log).catch(() => false);

      // Log into Unify if needed, then click into Modern Retail CRM. This
      // returns a SECOND tab sitting inside the CRM — the original Unify tab
      // stays open because eLead's session is anchored to it (navigating it
      // away logs the CRM out).
      const entered = await enterCrm(page, creds, { restored, onLog: log });
      const crmPage = entered.page;
      if (!crmPage) {
        throw Object.assign(new Error("could not reach the CRM (login/entry failed)"), { proxy });
      }

      // Persist the refreshed session (one doc per store, updated in place).
      // Cookies are read browser-wide via CDP, so the CRM tab captures both
      // the Unify and crm.connectcdk.com cookies.
      await saveSession(crmPage, storeId, log).catch(() => {});

      // Run the full daily pipeline on the CRM tab / its context.
      const context = crmPage.browserContext
        ? crmPage.browserContext()
        : browser.defaultBrowserContext();
      const result = await runStorePipeline(crmPage, context, api, config, log);

      // Save again so any cookie refresh during the run is captured.
      await saveSession(crmPage, storeId, log).catch(() => {});

      return { ok: true, result };
    } finally {
      try { await browser.close(); } catch {}
    }
  };

  // First attempt, with a single proxy-rotation retry on block-like failures.
  try {
    return await attempt(false);
  } catch (err) {
    log(`First attempt failed: ${err.message}`);
    if (looksLikeProxyBlock(err)) {
      log("Failure looks proxy-related — retiring IP and retrying once on a fresh one.");
      try { await retireProxy(storeId); } catch (e) { log(`retireProxy failed: ${e.message}`); }
      await sleep(2000);
      try {
        return await attempt(true);
      } catch (err2) {
        log(`Retry failed: ${err2.message} — giving up on this store tonight.`);
        return { ok: false, error: err2.message };
      }
    }
    return { ok: false, error: err.message };
  }
}

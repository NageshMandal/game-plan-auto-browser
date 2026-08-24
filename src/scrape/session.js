// ---------------------------------------------------------------------------
// src/scrape/session.js — persist a logged-in CRM session per account, in Mongo.
//
// Same idea as the on-disk src/session.js the single-target browser used, but
// the store is MongoDB and the key is the account's store_id. Exactly ONE
// document per account (crm_sessions), updated in place every run — never a
// new doc — as the brief requires.
//
// What we persist is the AUTH STATE only: every cookie (CDP getAllCookies) plus
// localStorage for the app origin. We do NOT use a persistent Chrome profile,
// for the same reason src/browser.js documents: puppeteer-real-browser owns a
// throwaway profile that carries the anti-detection setup.
// ---------------------------------------------------------------------------
import { loadSession as mongoLoad, saveSession as mongoSave } from "../store/mongo.js";
import { CRM_HOST } from "../config.js";

function toCookieParam(c) {
  const p = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (typeof c.expires === "number" && c.expires > 0) p.expires = c.expires;
  if (c.sameSite && ["Strict", "Lax", "None"].includes(c.sameSite)) p.sameSite = c.sameSite;
  return p;
}

// Capture cookies + localStorage → Mongo (upsert on store_id).
export async function saveSession(page, storeId, onLog = () => {}) {
  let client;
  try {
    client = await page.createCDPSession();
    await client.send("Network.enable").catch(() => {});
    const { cookies } = await client.send("Network.getAllCookies");

    const store = await page
      .evaluate(() => {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          data[k] = localStorage.getItem(k);
        }
        return { origin: location.origin, data };
      })
      .catch(() => null);

    const payload = {
      savedAt: new Date().toISOString(),
      cookies: cookies.map(toCookieParam),
      origins: store && Object.keys(store.data).length ? [store] : [],
    };
    await mongoSave(storeId, payload);
    onLog(`Session saved (${payload.cookies.length} cookies) for store ${storeId}`);
    return true;
  } catch (err) {
    onLog(`Could not save session for ${storeId}: ${err.message.split("\n")[0]}`);
    return false;
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}

// Re-inject a saved session BEFORE the first navigation. Returns true if a
// session was found and applied (not a guarantee it's still valid).
//
// IMPORTANT: we deliberately do NOT restore cookies for the eLead CRM host.
// eLead sessions are short-lived and server-side; replaying yesterday's
// SESSIONID makes eLead reject it and answer with login.asp?logout=1, which
// also tears down the session the SSO is trying to establish. A fresh browser
// works precisely because it has no stale CRM cookie. So we restore only the
// Unify/Okta identity cookies — which is what saves us the password login —
// and let the SAML handshake mint a brand-new eLead session every run.
export async function restoreSession(page, storeId, onLog = () => {}) {
  const payload = await mongoLoad(storeId).catch(() => null);
  if (!payload) return false;

  let client;
  try {
    client = await page.createCDPSession();
    await client.send("Network.enable").catch(() => {});
    if (Array.isArray(payload.cookies) && payload.cookies.length) {
      const isCrmCookie = (c) =>
        String(c.domain || "").replace(/^\./, "").toLowerCase().includes(CRM_HOST.toLowerCase());
      const keep = payload.cookies.filter((c) => !isCrmCookie(c));
      const dropped = payload.cookies.length - keep.length;
      if (keep.length) {
        await client.send("Network.setCookies", { cookies: keep });
      }
      onLog(
        `Restored ${keep.length} cookies for store ${storeId}` +
          (dropped ? ` (skipped ${dropped} stale ${CRM_HOST} cookie(s) — SSO will mint a fresh session)` : ""),
      );
    } else {
      onLog(`No cookies to restore for store ${storeId}`);
    }
    for (const o of payload.origins || []) {
      if (!o?.origin || !o.data) continue;
      // Don't replay CRM localStorage either — same staleness problem.
      if (o.origin.includes(CRM_HOST)) continue;
      try {
        await page.goto(o.origin + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.evaluate((data) => {
          for (const [k, v] of Object.entries(data)) {
            try { localStorage.setItem(k, v); } catch {}
          }
        }, o.data);
      } catch {
        /* cookies alone are usually enough */
      }
    }
    return true;
  } catch (err) {
    onLog(`Could not restore session for ${storeId}: ${err.message.split("\n")[0]}`);
    return false;
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}
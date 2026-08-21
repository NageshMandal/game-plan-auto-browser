// ---------------------------------------------------------------------------
// src/session.js — keep a logged-in session across launches WITHOUT a
// persistent Chrome profile.
//
// ## Why not just set customConfig.userDataDir
//
// Because it breaks the thing that makes this work. puppeteer-real-browser
// prepares its own throwaway profile with the preferences and flags that stop
// Chrome looking automated, and it expects to own that directory. Point it at a
// profile of your own and that preparation is skipped — Chrome starts without
// the anti-detection setup and gets challenged on every run. The throwaway
// profile IS the mechanism, so we keep it and persist only the AUTH STATE by
// hand: the cookie jar plus localStorage for the app origin. That is all a
// logged-in session actually is.
//
// ## What gets saved
//
//   • Every cookie, across all domains (CDP Network.getAllCookies). The one
//     that matters most is the identity-provider session cookie on
//     login.connectcdk.com — that is what lets the app silently re-auth instead
//     of showing the form again.
//   • localStorage for whatever origin we are on at save time (the app), where
//     OIDC libraries usually park tokens.
//
// sessionStorage is deliberately NOT saved: it cannot outlive a browser by
// definition, so persisting it would be a lie.
//
// ## The catch worth knowing
//
// A restored session cookie arriving from a DIFFERENT proxy exit IP than the
// one it was issued to often gets invalidated by the IdP — which looks exactly
// like "it logged me out again". That is why this pairs with the sticky-proxy
// option in browser.js: same profile, same exit IP, every launch.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";

// CDP setCookies rejects unknown fields, so map getAllCookies output down to
// the parameters it accepts. A session cookie (expires <= 0) is sent with no
// expiry so it stays a session cookie rather than becoming a dead one.
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

/**
 * Capture the current auth state to disk. Call this once, right after a
 * confirmed successful login (or when already logged in, to refresh expiries).
 */
export async function saveSession(page, filePath, onStage = () => {}) {
  let client;
  try {
    client = await page.createCDPSession();
    await client.send("Network.enable").catch(() => {});
    const { cookies } = await client.send("Network.getAllCookies");

    // localStorage for the origin we are currently on (the app).
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

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    onStage(`Session saved (${payload.cookies.length} cookies) → ${filePath}`);
    return true;
  } catch (err) {
    onStage(`Could not save the session: ${err.message.split("\n")[0]}`);
    return false;
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}

/**
 * Re-inject a saved session BEFORE navigating to the target. Sets every cookie,
 * then visits each saved origin to restore its localStorage. Returns true if a
 * file was found and applied — not a guarantee the session is still valid, only
 * that it was put back. Whether it actually works is decided by the navigation
 * that follows.
 */
export async function restoreSession(page, filePath, onStage = () => {}) {
  if (!existsSync(filePath)) return false;

  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    onStage(`Session file unreadable, ignoring it: ${err.message.split("\n")[0]}`);
    return false;
  }

  let client;
  try {
    client = await page.createCDPSession();
    await client.send("Network.enable").catch(() => {});

    if (Array.isArray(payload.cookies) && payload.cookies.length) {
      await client.send("Network.setCookies", { cookies: payload.cookies });
    }

    // localStorage can only be written while ON the origin, so visit each one.
    for (const o of payload.origins || []) {
      if (!o?.origin || !o.data) continue;
      try {
        await page.goto(o.origin + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.evaluate((data) => {
          for (const [k, v] of Object.entries(data)) {
            try {
              localStorage.setItem(k, v);
            } catch {}
          }
        }, o.data);
      } catch {
        // Non-fatal: cookies alone are usually enough to restore the session.
      }
    }

    const age = payload.savedAt ? `, saved ${payload.savedAt}` : "";
    onStage(`Restored ${payload.cookies?.length || 0} cookies${age}`);
    return true;
  } catch (err) {
    onStage(`Could not restore the session: ${err.message.split("\n")[0]}`);
    return false;
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}

export function clearSession(filePath) {
  try {
    if (existsSync(filePath)) rmSync(filePath);
    return true;
  } catch {
    return false;
  }
}

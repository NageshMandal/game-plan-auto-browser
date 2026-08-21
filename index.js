#!/usr/bin/env node
// ---------------------------------------------------------------------------
// index.js — open ConnectCDK Unify, wait for it to bounce us to its login page,
// then shut the browser down.
//
//   npm start                        normal run (proxy from .env)
//   npm run direct                   force a direct connection, no proxy
//   npm run headless                 headless (worse for detection — debug only)
//   node index.js --keep-open 30     hold the window open 30s before closing
//
// Flags are used rather than env-var prefixes because PowerShell does not
// support `HEADLESS=true node index.js` — that is bash syntax and fails on
// Windows with "The term 'HEADLESS=true' is not recognized".
// ---------------------------------------------------------------------------
import "dotenv/config";
import { existsSync } from "node:fs";
import { openBrowser } from "./src/browser.js";
import { submitLogin, hasCredentials } from "./src/login.js";
import { saveSession, restoreSession, clearSession } from "./src/session.js";

const TARGET = process.env.TARGET_URL || "https://app-unify.app.connectcdk.com/applications";
const PROFILE = "connectcdk";

// Where the saved session and the pinned proxy IP live. Both are gitignored.
const SESSION_FILE = process.env.CONNECTCDK_SESSION_FILE || "./.session/connectcdk.json";
const STICKY_PROXY_FILE = `./.session/proxy-${PROFILE}.json`;

// The app's own host and path, used to tell "we're in the app" from "we got
// bounced to the login host". Derived from TARGET so overriding the URL works.
const APP_HOST = new URL(TARGET).host;
const APP_PATH_PREFIX = new URL(TARGET).pathname; // e.g. /applications

// A restored session sitting continuously on the app path for this long counts
// as "already signed in". Long enough that a not-signed-in load has time to
// redirect to the login host first (that redirect resets the timer).
const APP_SETTLE_MS = Number(process.env.APP_SETTLE_MS) || 5000;

// Unify is an SSO'd SPA: the hop to the identity provider can be a 302, a
// client-side router push, or several of both. So the wait polls page.url()
// from Node rather than using waitForFunction — an in-page waiter dies with
// "Execution context was destroyed" on exactly the navigation we want to see.
const REDIRECT_TIMEOUT_MS = Number(process.env.REDIRECT_TIMEOUT_MS) || 60000;
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS) || 60000;
const POLL_MS = 400;
const SETTLE_POLLS = 6; // ~2.4s of an unchanging URL counts as "arrived"

// Okta hands off in stages: /login/authorize (a redirector, blank page, no form)
// -> /login/?client_id=... -> /login/login (the actual form). The first of those
// already matches LOGIN_HINT, so matching on URL alone stops ~12s early on a
// page that has no title and nothing to type into.
//
// So an auth-looking URL only opens a GRACE WINDOW: keep watching for a real
// credential field for this long before settling for the URL match. Costs
// nothing when the form appears immediately.
const FORM_GRACE_MS = Number(process.env.FORM_GRACE_MS) || 20000;

const LOGIN_HINT =
  /(login|signin|sign-in|sign_in|auth|authorize|oauth|openid|identity|sso|b2clogin|okta|onelogin|pingone|adfs|account)/i;

// --- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const val = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

if (has("headless")) process.env.HEADLESS = "true";
if (has("fullscreen")) process.env.WINDOW_MODE = "fullscreen";
if (has("maximized")) process.env.WINDOW_MODE = "maximized";
if (has("window-size")) process.env.WINDOW_SIZE = val("window-size", "");
const noProxy = has("direct");
// Login runs by default when credentials are present. --no-login opens the
// page and stops at the form (the earlier behaviour).
const doLogin = !has("no-login");
// Session persistence: on by default. --fresh ignores a saved session for this
// run (still re-saves after); --logout deletes it and exits.
const useSession = !has("fresh") && !has("no-session");
// How long to sit on the post-login page before closing. Defaults to 30s per
// the brief; --keep-open overrides it.
const holdMs = (has("keep-open") ? Number(val("keep-open", 30)) : 30) * 1000;

if (has("logout")) {
  clearSession(SESSION_FILE);
  console.log(`\n  Cleared saved session at ${SESSION_FILE}\n`);
  process.exit(0);
}

// --- helpers ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const log = (msg) => console.log(`  [${secs()}s] ${msg}`);

// A credential box is the only unambiguous "this is the login page" signal —
// hostnames and paths vary per tenant. Every call is wrapped because the DOM
// can be mid-navigation, and a torn-down context here is normal, not an error.
async function looksLikeLoginDom(page) {
  try {
    return await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      if (Array.from(document.querySelectorAll('input[type="password"]')).some(visible)) return true;
      const user = document.querySelector(
        'input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="email" i]'
      );
      return visible(user);
    });
  } catch {
    return false;
  }
}

// After navigating to the target we could end up in one of two places:
//   • the login page  — no session, or it expired → we must sign in
//   • the app itself   — a restored session was accepted → skip login
// This resolves { state: "login" | "app", url, reason } for whichever happens.
async function waitForSettle(page, startUrl) {
  const deadline = Date.now() + REDIRECT_TIMEOUT_MS;
  let seen = page.url();
  let graceStarted = 0; // when an auth-looking URL first appeared
  let appSince = 0;     // when we first landed continuously on the app path

  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== seen) {
      log(`→ ${url}`);
      seen = url;
    }

    // A visible credential field is the unambiguous "login" signal.
    if (await looksLikeLoginDom(page)) {
      return { state: "login", url, reason: "credential field on the page" };
    }

    let host = "";
    let path = "";
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch {}

    // On the app's own host and app path, with no login markers → signed in.
    // The /login/callback hop shares the app host but its path starts with
    // /login, so it correctly fails this check and is treated as in-flight.
    const onApp = host === APP_HOST && path.startsWith(APP_PATH_PREFIX) && !/\/login|callback/i.test(path);
    if (onApp) {
      if (!appSince) appSince = Date.now();
      if (Date.now() - appSince >= APP_SETTLE_MS) {
        return { state: "app", url, reason: "app loaded without a login prompt" };
      }
    } else {
      appSince = 0;
    }

    // An auth endpoint (different host, or a login/authorize path) opens a grace
    // window for the real form to render — see FORM_GRACE_MS.
    const authish = (host && host !== APP_HOST) || LOGIN_HINT.test(url);
    if (authish && !onApp) {
      if (!graceStarted) {
        graceStarted = Date.now();
        log(`Auth endpoint reached — watching ${FORM_GRACE_MS / 1000}s for the form`);
      }
      if (Date.now() - graceStarted >= FORM_GRACE_MS) {
        return { state: "login", url, reason: `auth endpoint, no form within ${FORM_GRACE_MS / 1000}s` };
      }
    }

    await sleep(POLL_MS);
  }

  // Timed out — decide on the best evidence to hand rather than throwing.
  if (await looksLikeLoginDom(page)) {
    return { state: "login", url: page.url(), reason: "timed out on a login-looking page" };
  }
  return { state: "app", url: page.url(), reason: "timed out; no login prompt seen" };
}

// After Sign In, CDK bounces back through the SSO callback to the app. We are
// "in" once the URL has left the login host AND the password field is gone. If
// we are still sitting on the form after the timeout, the credentials were
// rejected or an MFA/error state appeared — report it rather than hanging.
async function waitForPostLogin(page, loginUrl) {
  const loginHost = new URL(loginUrl).host;
  const deadline = Date.now() + REDIRECT_TIMEOUT_MS;
  let seen = page.url();

  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== seen) {
      log(`→ ${url}`);
      seen = url;
    }

    let host;
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }

    // Left the identity provider entirely — this is the success path.
    if (host && host !== loginHost) {
      // Let the destination SPA paint before we call it loaded.
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
      return { url: page.url(), reason: "left the login host" };
    }

    // Still on the login host: an inline error means the submit was rejected.
    const err = await readLoginError(page);
    if (err) throw new Error(`Login was rejected: ${err}`);

    await sleep(POLL_MS);
  }

  // Timed out on the login host with no explicit error — usually MFA, or a
  // silent rejection. Surface whatever text is on screen to make it debuggable.
  const err = await readLoginError(page);
  throw new Error(
    err
      ? `Still on the login page after ${REDIRECT_TIMEOUT_MS / 1000}s: ${err}`
      : `Signed in but the page did not move within ${REDIRECT_TIMEOUT_MS / 1000}s ` +
        `(still at ${page.url()} — an MFA step or a silent rejection is the usual cause)`
  );
}

// Best-effort scrape of a visible validation/error message near the form. The
// styled-components class names are unstable, so this matches on text and role
// rather than selectors, and returns "" when nothing error-like is showing.
async function readLoginError(page) {
  try {
    return await page.evaluate(() => {
      const rx = /(incorrect|invalid|not recognized|wrong|failed|locked|too many|does not match|try again)/i;
      const nodes = Array.from(document.querySelectorAll('[role="alert"], [class*="error" i], span, div, p'));
      for (const n of nodes) {
        const r = n.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const t = (n.textContent || "").trim();
        if (t && t.length < 160 && rx.test(t)) return t;
      }
      return "";
    });
  } catch {
    return "";
  }
}

// --- run -------------------------------------------------------------------
console.log("\n\x1b[1mConnectCDK Unify — launch, follow the redirect, close\x1b[0m\n");
console.log(`  target   : ${TARGET}`);
console.log(`  profile  : ${PROFILE}   (selects PROXY_*_CONNECTCDK in .env)`);
console.log(`  proxy    : ${noProxy ? "disabled (--direct)" : "from .env"}`);
console.log(`  headless : ${process.env.HEADLESS === "true" ? "true (debug only)" : "false (correct)"}`);
console.log(`  window   : ${process.env.WINDOW_MODE || "maximized"}`);
console.log(`  platform : ${process.platform}\n`);

let browser;
let exitCode = 0;

try {
  const session = await openBrowser({
    profile: PROFILE,
    onStage: log,
    noProxy,
    // Pin one exit IP for this profile while a session is in play — a restored
    // cookie hitting a new random IP every launch is what forces re-login.
    stickyProxyPath: useSession ? STICKY_PROXY_FILE : undefined,
  });
  browser = session.browser;
  const page = session.page;

  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  // Log every main-frame hop, so a multi-step SSO chain is visible in the
  // output instead of collapsing into a single before/after.
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) log(`nav ${frame.url()}`);
  });

  // Put a previously saved session back BEFORE the first navigation, so the app
  // sees the auth cookies on its very first request and never bounces to login.
  let restored = false;
  if (useSession && existsSync(SESSION_FILE)) {
    log("Restoring saved session");
    restored = await restoreSession(page, SESSION_FILE, log);
  }

  log("Opening the applications URL");
  try {
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    // A goto interrupted by the redirect it triggered is the expected path
    // here, not a failure — only give up if we never left the start URL.
    if (page.url() === TARGET || page.url() === "about:blank") throw err;
    log(`Navigation interrupted by a redirect (${err.message.split("\n")[0]}) — following it`);
  }

  log(restored ? "Checking whether the restored session is still valid" : "Waiting to see where we land");
  const settled = await waitForSettle(page, TARGET);

  if (settled.state === "app") {
    // Restored session (or an existing one) was accepted — no login needed.
    console.log("\n" + "─".repeat(68));
    console.log(`  already in: ${settled.url}`);
    console.log(`  detected  : ${settled.reason}`);
    console.log(`  title     : ${await page.title().catch(() => "?")}`);
    console.log("─".repeat(68));
    log("Already signed in — skipping the login form");

    // Refresh the saved session so its cookie expiries roll forward.
    if (useSession) await saveSession(page, SESSION_FILE, log);
  } else {
    // On the login page: session absent, expired, or rejected.
    if (restored) log("Saved session was not accepted — signing in again");

    console.log("\n" + "─".repeat(68));
    console.log(`  login page: ${settled.url}`);
    console.log(`  detected  : ${settled.reason}`);
    console.log("─".repeat(68) + "\n");

    if (doLogin && hasCredentials()) {
      const loginUrl = page.url();
      await submitLogin(page, log);

      log("Waiting for the page after Sign In to load");
      const after = await waitForPostLogin(page, loginUrl);

      console.log("\n" + "─".repeat(68));
      console.log(`  signed in : ${after.url}`);
      console.log(`  detected  : ${after.reason}`);
      console.log(`  title     : ${await page.title().catch(() => "?")}`);
      console.log("─".repeat(68));

      // Save the fresh session so the NEXT run skips the form entirely.
      if (useSession) await saveSession(page, SESSION_FILE, log);
    } else if (doLogin) {
      log("No CONNECTCDK_EMAIL / CONNECTCDK_PASSWORD in .env — stopping at the form");
    }
  }

  if (holdMs > 0) {
    log(`Holding on this page for ${holdMs / 1000}s`);
    await sleep(holdMs);
  }
} catch (err) {
  exitCode = 1;
  console.log(`\n\x1b[31m  Failed:\x1b[0m ${err.message}\n`);
  console.log("  In order of likelihood:");
  console.log("    1. Proxy exit IP dead or unauthorised — the page never loads at all.");
  console.log("       Prove it:  npm run direct   (if that works, it is the proxy, not the site)");
  console.log("    2. Google Chrome is not installed — this drives your system Chrome,");
  console.log("       it does not download its own Chromium.");
  console.log("    3. Running headless. Re-run without --headless.");
  console.log("    4. Corporate VPN/TLS inspection intercepting the request.\n");
} finally {
  // Unconditional. A leaked Chrome holds the proxy slot and the memory; a
  // handful of orphaned chrome.exe processes is a very easy way to end up
  // debugging a "hang" that is really just exhaustion.
  if (browser) {
    log("Closing the browser");
    await browser.close().catch(() => {});
  }
}

console.log(exitCode === 0 ? "\n\x1b[32m  Done.\x1b[0m\n" : "");
process.exit(exitCode);
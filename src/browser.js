// ---------------------------------------------------------------------------
// src/browser.js — the one place this project launches Chrome.
//
// Everything that opens a browser goes through openBrowser(). Keeping it to a
// single function is not tidiness for its own sake: the launch options below
// are load-bearing, and a second `connect()` elsewhere in the project will
// quietly differ from these and then get challenged for reasons nobody can
// reproduce.
//
// ## Do not add a persistent user profile
//
// The obvious optimisation is `customConfig: { userDataDir: "./profile" }` so a
// solved bot-check is remembered between runs. It backfires. puppeteer-real-
// browser does not merely launch Chrome — it prepares a throwaway profile
// first, writing the preferences and launch flags that stop the browser looking
// automated, and it expects to own that directory. Pointing it at a directory
// of your own skips that preparation: Chrome starts WITHOUT the anti-detection
// setup and gets challenged immediately. The throwaway profile is not waste to
// optimise away — it is the mechanism.
//
// ## Windows
//
// disableXvfb must be true anywhere that is not Linux. Xvfb is an X11 virtual
// display; there is no such thing on Windows, and leaving it enabled makes the
// launch hang or throw before Chrome ever starts. It is set from process.platform
// below so the same file also works if this is later deployed to a Linux box.
//
// You also need real Google Chrome installed — the library drives your system
// Chrome, it does not download a bundled Chromium the way plain puppeteer does.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { connect } from "puppeteer-real-browser";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Xvfb only exists on Linux. On Windows/macOS it must be off.
const NEEDS_XVFB = process.platform === "linux";

// Minimum gap between launches. A burst of sessions from one address is scored
// more harshly than the same number spread out. Set BROWSER_LAUNCH_GAP_MS=0 off.
//
// NOTE: parseInt of an unset env var is NaN, and `??` does NOT catch NaN — the
// obvious one-liner makes the gap permanently NaN, so it never waits at all.
const parsedGap = parseInt(process.env.BROWSER_LAUNCH_GAP_MS, 10);
const LAUNCH_GAP_MS = Math.max(0, Number.isFinite(parsedGap) ? parsedGap : 8000);

let lastLaunch = 0;

// The gap check is read-then-wait-then-write, which two concurrent callers can
// both pass before either updates `lastLaunch` — producing exactly the
// simultaneous burst the gap exists to prevent. Chaining the *reservation* of a
// launch slot through one promise makes the spacing atomic: N parallel jobs
// launch one browser every LAUNCH_GAP_MS, then run fully in parallel from there.
let launchSlot = Promise.resolve();

function reserveLaunchSlot(onStage) {
  const mine = launchSlot.then(async () => {
    const since = Date.now() - lastLaunch;
    if (lastLaunch && since < LAUNCH_GAP_MS) {
      const wait = LAUNCH_GAP_MS - since;
      onStage(`Waiting ${Math.ceil(wait / 1000)}s before opening the browser again`);
      await sleep(wait);
    }
    lastLaunch = Date.now();
  });
  // The chain must survive a rejection, or one failure poisons every launch after it.
  launchSlot = mine.catch(() => {});
  return mine;
}

// ---------------------------------------------------------------------------
// Proxy resolution, scoped by profile name.
//
// A browser opened with profile "connectcdk" resolves in this order:
//   PROXY_FILE_CONNECTCDK / PROXY_LIST_CONNECTCDK  → a POOL; one entry per launch
//   PROXY_HOST_CONNECTCDK (+ _PORT/_USER/_PASS)    → a single proxy
//   the same names with no suffix                  → global fallback
//   PROXY_HOST[_PROFILE]=direct                    → explicit opt-out
//   nothing set                                    → no proxy
//
// Scoping matters once there is more than one target: a site you hold a logged-
// in account on should NOT hop between proxy exit IPs every run, while a site
// that scores your datacentre IP badly needs exactly that. One flag per site.
//
// Pool formats are what providers hand out:
//   PROXY_FILE_CONNECTCDK=./proxies.txt        one host:port:user:pass per line
//                                              (Webshare's download format, as-is)
//   PROXY_LIST_CONNECTCDK=h1:p1:u:pw,h2:p2:u:pw   same entries, comma-separated
//
// One entry is chosen AT RANDOM per launch, so a retry naturally goes out
// through a different exit IP with no bookkeeping.
// ---------------------------------------------------------------------------

// `host:port` or `host:port:user:pass`.
function parseProxyEntry(raw) {
  const s = String(raw || "").trim();
  if (!s || s.startsWith("#")) return null;
  const [host, port, username, password] = s.split(":");
  const p = Number(port);
  if (!host || !Number.isFinite(p) || p <= 0) return null;
  return { host, port: p, username: username || undefined, password: password || undefined };
}

function proxyPool(pick) {
  const entries = [];

  const list = pick("PROXY_LIST");
  if (list) {
    for (const item of list.split(/[,\s]+/)) {
      const e = parseProxyEntry(item);
      if (e) entries.push(e);
    }
  }

  const file = pick("PROXY_FILE");
  if (file) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const e = parseProxyEntry(line);
        if (e) entries.push(e);
      }
    } catch (err) {
      console.warn(`  Proxy file "${file}" could not be read: ${err.message}`);
    }
  }

  return entries;
}

export function proxyConfig(profile, { stickyPath } = {}) {
  const suffix = String(profile || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");

  const pick = (name) => {
    const scoped = suffix ? process.env[`${name}_${suffix}`] : undefined;
    return scoped !== undefined && scoped !== "" ? scoped : process.env[name];
  };

  // An explicit opt-out beats everything, so one target can stay direct while a
  // global pool is configured: PROXY_HOST_CONNECTCDK=direct
  const host = pick("PROXY_HOST");
  if (host && /^(direct|none|off)$/i.test(host)) return undefined;

  // A pool, when configured, beats the single-host variables.
  const pool = proxyPool(pick);
  if (pool.length) {
    const chosen = chooseFromPool(pool, stickyPath);
    return { ...chosen, poolSize: pool.length, sticky: !!stickyPath };
  }

  if (!host) return undefined;
  return {
    host,
    port: Number(pick("PROXY_PORT")) || 8080,
    username: pick("PROXY_USER") || undefined,
    password: pick("PROXY_PASS") || undefined,
  };
}

// Pick one pool entry. Normally random per launch (good for scraping retries).
// But when `stickyPath` is given — which it is for a profile that holds a
// login — the chosen exit IP is written to disk and REUSED next launch, as long
// as it is still in the pool. A restored session cookie hitting the same IP it
// was issued to survives; a random new IP every launch is what gets it
// invalidated and forces the login form back. If the pinned IP has dropped out
// of the pool (rotated away by the provider), a fresh one is picked and saved.
function chooseFromPool(pool, stickyPath) {
  if (stickyPath && existsSync(stickyPath)) {
    try {
      const saved = JSON.parse(readFileSync(stickyPath, "utf8"));
      const match = pool.find((e) => e.host === saved.host && e.port === saved.port);
      if (match) return match;
    } catch {}
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  if (stickyPath) {
    try {
      mkdirSync(dirname(stickyPath), { recursive: true });
      writeFileSync(stickyPath, JSON.stringify({ host: chosen.host, port: chosen.port }));
    } catch {}
  }
  return chosen;
}

export const headless = () => process.env.HEADLESS === "true";

// ---------------------------------------------------------------------------
// Window size.
//
// Two separate things have to be right or the window looks maximised while the
// PAGE is still 800x600:
//
//   1. --start-maximized tells Chrome how to open its window.
//   2. defaultViewport: null stops puppeteer immediately overriding the content
//      area back to its own 800x600 default. Without this, args alone give you
//      a full-screen window with a small page rendered inside it — and a 800x600
//      viewport is itself a mild bot signal, since almost no real desktop
//      reports that.
//
// The flag is also only a *request*. Windows in particular sometimes restores
// the previous window state instead, so maximizeWindow() below re-asserts it
// over CDP after launch, which is authoritative.
//
//   WINDOW_MODE=maximized   normal window, filling the desktop (default)
//   WINDOW_MODE=fullscreen  F11-style, no title bar or tabs
//   WINDOW_MODE=normal      leave it alone / use WINDOW_SIZE
//   WINDOW_SIZE=1920,1080   explicit size; also used as the headless viewport
// ---------------------------------------------------------------------------
const WINDOW_MODE = (process.env.WINDOW_MODE || "maximized").toLowerCase();

function parseWindowSize() {
  const m = String(process.env.WINDOW_SIZE || "").match(/(\d{3,5})\s*[,x]\s*(\d{3,5})/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function windowArgs() {
  const size = parseWindowSize();
  const args = [];

  // Headless has no window manager, so --start-maximized is a no-op there.
  // The only thing that sets the size is an explicit viewport.
  if (headless()) {
    const { width, height } = size || { width: 1920, height: 1080 };
    args.push(`--window-size=${width},${height}`);
    return args;
  }

  if (WINDOW_MODE === "fullscreen") args.push("--start-fullscreen");
  else if (WINDOW_MODE === "maximized") args.push("--start-maximized");

  if (size) args.push(`--window-size=${size.width},${size.height}`);
  return args;
}

/**
 * Re-assert the window state over CDP after launch. The launch flag is a hint
 * the OS may ignore; Browser.setWindowBounds is not.
 *
 * Chrome rejects a bounds change made while already in a non-normal state, so
 * this drops to "normal" first — that is why the first send is not redundant.
 */
export async function maximizeWindow(page, mode = WINDOW_MODE) {
  if (headless() || mode === "normal") return false;
  let session;
  try {
    session = await page.createCDPSession();
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: mode === "fullscreen" ? "fullscreen" : "maximized" },
    });
    return true;
  } catch {
    // Non-fatal: the flag usually did the job already, and a browser that is
    // merely the wrong size is not worth aborting a run over.
    return false;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

/**
 * Launch Chrome. Returns puppeteer-real-browser's { browser, page }.
 *
 * @param {object}   opts
 * @param {string}   opts.profile  selects the PROXY_*_<PROFILE> variables
 * @param {function} opts.onStage  progress callback
 * @param {boolean}  opts.noProxy  force a direct connection for this launch
 */
export async function openBrowser({
  profile = "default",
  onStage = () => {},
  noProxy = false,
  stickyProxyPath,
  proxyOverride,
} = {}) {
  await reserveLaunchSlot(onStage);

  // proxyOverride wins when supplied — this is how the multi-account runner
  // hands each CRM account its dedicated, allocator-chosen IP (see
  // src/store/proxyAllocator.js). When absent we fall back to the original
  // .env / sticky-file resolution, so single-target `npm start` is unchanged.
  const proxy = noProxy
    ? undefined
    : proxyOverride
      ? { ...proxyOverride, poolSize: undefined, sticky: true }
      : proxyConfig(profile, { stickyPath: stickyProxyPath });
  if (proxy) {
    onStage(
      `Routing ${profile} through proxy ${proxy.host}:${proxy.port}` +
        (proxy.poolSize ? ` (${proxy.sticky ? "pinned" : "1"} of ${proxy.poolSize} in the pool)` : "")
    );
  } else {
    onStage(`Opening ${profile} with a direct connection (no proxy)`);
  }

  // poolSize/sticky are our own bookkeeping — the library only expects host/port/auth.
  const { poolSize, sticky, ...proxyOpt } = proxy || {};

  const session = await connect({
    headless: headless(),
    turnstile: true,        // auto-solve Cloudflare Turnstile widgets when they appear
    args: windowArgs(),
    customConfig: {},       // stays EMPTY on purpose — see the note at the top
    // defaultViewport: null = "the page fills whatever the window is". Omit it
    // and puppeteer clamps the content area to 800x600 inside your maximised window.
    connectOption: { defaultViewport: null },
    disableXvfb: !NEEDS_XVFB,
    ignoreAllFlags: false,
    ...(proxy ? { proxy: proxyOpt } : {}),
  });

  await maximizeWindow(session.page);

  // Report what the page actually got, not what was asked for. If this prints
  // 800x600 the viewport override came back — check connectOption.
  const size = await session.page
    .evaluate(() => `${window.innerWidth}x${window.innerHeight}`)
    .catch(() => "unknown");
  onStage(`Window ${headless() ? "headless" : WINDOW_MODE} — viewport ${size}`);

  return session;
}
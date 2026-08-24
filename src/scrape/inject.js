// ---------------------------------------------------------------------------
// src/scrape/inject.js — run the extension's DOM code inside puppeteer.
//
// The scraper's extraction logic lives in two files copied VERBATIM into
// ./assets: content.js (per-lead DOM scraping, tab handling, messenger) and
// desklog_extractor.js (report-table + drilldown parsing). Both are plain DOM
// functions — the only browser-extension coupling in content.js is a
// chrome.runtime.onMessage listener and one chrome.runtime.sendMessage call.
//
// We reuse the logic without rewriting it:
//   • Strip the two `chrome.*` references from content.js at load time (they
//     are the message router and a click-to-call ping — neither is used when
//     we call the functions directly), and expose every top-level function on
//     window.__gp so page.evaluate can invoke it.
//   • desklog_extractor.js has no chrome coupling — inject as-is.
//
// This file also provides the puppeteer equivalents of the chrome APIs the
// pipeline leaned on: evaluateInAllFrames (≈ executeInAllFrames), safeNavigate,
// waitForLoad, and the beforeunload/popup neutralisers.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CRM_HOST, LEGACY_CRM_HOST, NAV_TIMEOUT_MS } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, "..", "..", "assets");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rewrite any legacy www.eleadcrm.com URL to the live CRM host. The injected
// DOM assets hard-code the old host when they build canonical URLs; every URL
// they emit passes through here so downstream navigation hits crm.connectcdk.
export function rehostUrl(url) {
  if (!url) return url;
  return String(url)
    .split(LEGACY_CRM_HOST)
    .join(CRM_HOST);
}

// ── Load + de-chrome content.js once ────────────────────────────────────────
// We transform the file so that instead of registering a chrome.runtime
// listener, its functions are attached to window.__gp. Since content.js wraps
// everything in an `if (window.__gpScraperLoaded__) {...} else {...}` guard and
// declares functions with `function foo(){}` at the top of the else-block,
// those are function declarations on the block scope — not global. We therefore
// append an explicit export map that lifts the ones the pipeline calls onto
// window.__gp, and neutralise the two chrome.* touch-points.
let _contentSource = null;
function contentScriptSource() {
  if (_contentSource) return _contentSource;
  let src = readFileSync(join(ASSETS, "content.js"), "utf8");

  // Neutralise the extension-only bits so the file runs in a plain page:
  //   • the chrome.runtime.onMessage router (we call functions directly)
  //   • the chrome.runtime.sendMessage click-to-call ping
  // Replacing `chrome` with a harmless stub object is enough — the listener
  // registers on the stub and is never invoked; sendMessage becomes a no-op.
  const stub = `var chrome = (typeof chrome !== 'undefined') ? chrome : { runtime: { onMessage: { addListener: function(){} }, sendMessage: function(){}, lastError: null } };\n`;

  // The file's guard uses `else {` right after the loaded check. We inject the
  // stub just inside that else block, and an exposer just before its closing.
  // Simpler and robust: wrap the whole file so its function declarations live
  // in a function scope we control, then hand-pick exports.
  _contentSource = `
(function(){
  ${stub}
  // Defuse the idempotent guard so our wrapper always defines the functions.
  try { window.__gpScraperLoaded__ = false; } catch(e){}
  ${src}
  // Lift the DOM functions we call directly onto window.__gp.
  window.__gp = window.__gp || {};
  var _names = ['scrapeMainPage','findAllSubPageUrls','scrapeAnyPage','scrapeCallDripData',
    'collectLeadLinksFromPage','listLeadPageTabs','clickLeadPageTab','scrapeTabIframe',
    'scrapeTextMessagesPage','buildRepIndex','getSalesReps','getSalesTeam','resolveRepType',
    'callDripIdFromUrl'];
  for (var i=0;i<_names.length;i++){
    try { if (typeof eval(_names[i]) === 'function') window.__gp[_names[i]] = eval(_names[i]); } catch(e){}
  }
})();
`;
  return _contentSource;
}

let _extractorSource = null;
function extractorSource() {
  if (_extractorSource) return _extractorSource;
  const src = readFileSync(join(ASSETS, "desklog_extractor.js"), "utf8");
  // No chrome coupling — expose its three parsers on window.__gp too.
  _extractorSource = `
${src}
window.__gp = window.__gp || {};
try { window.__gp.extractDesklogStats = extractDesklogStats; } catch(e){}
try { window.__gp.extractDrilldownLeadUrls = extractDrilldownLeadUrls; } catch(e){}
try { window.__gp.extractLeadSourceStats = extractLeadSourceStats; } catch(e){}
`;
  return _extractorSource;
}

// Inject both asset bundles into the top frame of `page`. Idempotent per call —
// safe to run after every navigation. Errors (CSP, mid-nav) are swallowed.
export async function ensureAssets(page) {
  try {
    await page.evaluate(contentScriptSource());
  } catch {
    /* frame torn down mid-nav — caller re-injects after settle */
  }
  try {
    await page.evaluate(extractorSource());
  } catch {
    /* ditto */
  }
}

// Inject the assets into EVERY same-origin frame of the page and return the
// page's frames so the caller can evaluate in each. eLead renders reports and
// the lead tabs inside nested iframes, so the equivalent of the extension's
// allFrames:true injection is to walk page.frames() and inject per frame.
export async function ensureAssetsAllFrames(page) {
  const content = contentScriptSource();
  const extractor = extractorSource();
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(content);
      await frame.evaluate(extractor);
    } catch {
      /* cross-origin or detached frame — skip */
    }
  }
}

// evaluateInAllFrames — run `fn` (a browser-context function) in every frame,
// collecting { result } entries like the extension's executeInAllFrames did.
// `args` are forwarded to each frame's evaluate call.
export async function evaluateInAllFrames(page, fn, args = []) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(fn, ...args);
      out.push({ result });
    } catch {
      out.push({ result: null });
    }
  }
  return out;
}

// evaluateInMainFrame — run `fn` in the top frame only, returning its value or
// null. Mirrors executeInMainFrame.
export async function evaluateInMainFrame(page, fn, args = []) {
  try {
    return await page.evaluate(fn, ...args);
  } catch {
    return null;
  }
}

// Neutralise beforeunload handlers + window.open/alert/confirm popups in every
// frame, exactly as background.js did in the MAIN world. In puppeteer we are
// already in the page's JS context, so a plain evaluate is the MAIN world.
// Arm a page ONCE, right after it is created, so popup suppression survives
// every future navigation.
//
// neutralizePage() runs via page.evaluate against the CURRENT document, so the
// window.open stub is wiped by the next goto — the new document starts clean
// and its own onload handler can fire window.open before we re-stub. That is
// how the desking Quote page spawned a separate "Vehicle Search" Chrome window.
//
// evaluateOnNewDocument installs the stub into every future document BEFORE any
// of that page's own scripts run, which closes the gap. The 'popup' listener is
// a second line of defence for popups the stub can't intercept (target=_blank,
// browser-level window opens): they are closed the moment they appear.
export async function armPage(page, onLog = () => {}) {
  try {
    await page.evaluateOnNewDocument(() => {
      try {
        window.__gpPopupsNeutralized__ = true;
        window.open = function () { return null; };
        window.alert = function () { return undefined; };
        window.confirm = function () { return true; };
        window.prompt = function () { return null; };
        window.onbeforeunload = null;
        const origAdd = window.addEventListener;
        window.addEventListener = function (type, listener, opts) {
          if (type === "beforeunload" || type === "unload") return;
          return origAdd.call(this, type, listener, opts);
        };
      } catch (e) {}
    });
  } catch (err) {
    onLog(`  ⚠ could not arm popup suppression: ${err.message}`);
  }

  // Any popup that still gets through is closed immediately.
  try {
    page.on("popup", async (popup) => {
      if (!popup) return;
      let u = "";
      try { u = popup.url(); } catch {}
      try { await popup.close(); } catch {}
      onLog(`  ✕ blocked popup${u ? `: ${u.slice(0, 90)}` : ""}`);
    });
  } catch {}
}

export async function neutralizePage(page) {
  const script = () => {
    try {
      window.onbeforeunload = null;
      if (document.body) document.body.onbeforeunload = null;
      const origWinAdd = window.addEventListener;
      window.addEventListener = function (type, listener, opts) {
        if (type === "beforeunload" || type === "unload") return;
        return origWinAdd.call(this, type, listener, opts);
      };
      try {
        Object.defineProperty(window, "onbeforeunload", {
          get() { return null; },
          set() {},
          configurable: true,
        });
      } catch (e) {}
      if (window.jQuery) {
        try {
          window.jQuery(window).off("beforeunload");
          window.jQuery(document).off("beforeunload");
        } catch (e) {}
      }
      if (!window.__gpPopupsNeutralized__) {
        window.__gpPopupsNeutralized__ = true;
        window.open = function () { return null; };
        window.alert = function () { return undefined; };
        window.confirm = function () { return true; };
        window.prompt = function () { return null; };
      }
    } catch (e) {}
  };
  for (const frame of page.frames()) {
    try { await frame.evaluate(script); } catch {}
  }
}

// waitForLoad — poll document.readyState in the top frame until 'complete',
// then neutralise. Mirrors the extension's waitForLoad.
export async function waitForLoad(page, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await evaluateInMainFrame(page, () => document.readyState);
    if (ready === "complete") {
      await sleep(1500);
      await neutralizePage(page);
      return true;
    }
    await sleep(400);
  }
  return false;
}

// Transient network failures worth retrying. ERR_TUNNEL_CONNECTION_FAILED is
// the common one behind a rotating/again-busy proxy: the CONNECT tunnel is
// refused, usually because the proxy hit its concurrent-connection cap. A
// short backoff and retry almost always gets through.
const TRANSIENT_NET = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_SOCKET_NOT_CONNECTED/i;

// safeNavigate — neutralise (so no "Leave site?" dialog blocks us), then
// navigate, retrying transient proxy/tunnel failures. Returns true on success.
export async function safeNavigate(page, url, timeout = NAV_TIMEOUT_MS, attempts = 3) {
  const target = rehostUrl(url);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await neutralizePage(page).catch(() => {});
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout });
      return true;
    } catch (err) {
      const msg = String(err && err.message);
      // A goto interrupted by the redirect it triggered still landed us
      // somewhere real (very common mid-SAML) — treat that as success.
      let here = "";
      try { here = page.url(); } catch {}
      if (here && here !== "about:blank" && !TRANSIENT_NET.test(msg)) return true;

      if (TRANSIENT_NET.test(msg) && attempt < attempts) {
        // Exponential-ish backoff: 2s, 5s. Gives the proxy time to free a slot.
        await sleep(attempt === 1 ? 2000 : 5000);
        continue;
      }
      if (here && here !== "about:blank") return true;
      return false;
    }
  }
  return false;
}
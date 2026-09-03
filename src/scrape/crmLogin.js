// ---------------------------------------------------------------------------
// src/scrape/crmLogin.js — get from a fresh browser to inside the eLead CRM.
//
// Flow (per the brief):
//   1. Open the Unify applications URL.
//   2. If a restored session lands us in the app → skip login; else fill the
//      CDK Common Login form with the store's CRM credentials and submit.
//   3. From the applications page, click the "Modern Retail CRM" card.
//   4. Wait until we're on the eLead track host (crm.connectcdk.com), which is
//      where all the report/lead pages live.
//
// The login form fill reuses the exact selectors and typing strategy from the
// existing src/login.js — but takes credentials as arguments (one per store)
// instead of reading them from process.env.
// ---------------------------------------------------------------------------
import {
  UNIFY_APP_URL,
  CRM_HOST,
  ELEAD_INDEX_URL,
  MODERN_RETAIL_CRM_CARD_SELECTORS,
  CRM_SSO_URL,
  SSO_WAIT_MS,
  SSO_ATTEMPTS,
} from "../config.js";
import { sleep, safeNavigate, waitForLoad, armPage } from "./inject.js";

const EMAIL_SEL = "#emailId";
const PASSWORD_SEL = "#password";
const SUBMIT_SEL = '[data-testid="primary-button"]';

const APP_HOST = new URL(UNIFY_APP_URL).host;
const APP_PATH_PREFIX = new URL(UNIFY_APP_URL).pathname;
const LOGIN_HINT =
  /(login|signin|sign-in|auth|authorize|oauth|openid|identity|sso|okta|onelogin|pingone|adfs|account)/i;

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.click(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(selector, value, { delay: 45 });
}

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

// Resolve whether we landed on the login page or already in the app.
async function waitForSettle(page, { redirectTimeoutMs = 60000, formGraceMs = 20000, appSettleMs = 5000 } = {}) {
  const deadline = Date.now() + redirectTimeoutMs;
  let graceStarted = 0;
  let appSince = 0;
  while (Date.now() < deadline) {
    if (await looksLikeLoginDom(page)) return { state: "login" };
    let host = "", path = "";
    try { const u = new URL(page.url()); host = u.host; path = u.pathname; } catch {}
    const onApp = host === APP_HOST && path.startsWith(APP_PATH_PREFIX) && !/\/login|callback/i.test(path);
    if (onApp) {
      if (!appSince) appSince = Date.now();
      if (Date.now() - appSince >= appSettleMs) return { state: "app" };
    } else {
      appSince = 0;
    }
    const authish = (host && host !== APP_HOST) || LOGIN_HINT.test(page.url());
    if (authish && !onApp) {
      if (!graceStarted) graceStarted = Date.now();
      if (Date.now() - graceStarted >= formGraceMs) return { state: "login" };
    }
    await sleep(400);
  }
  return { state: (await looksLikeLoginDom(page)) ? "login" : "app" };
}

async function submitLogin(page, credentials, onLog = () => {}) {
  onLog("Waiting for the login form");
  try {
    await page.waitForSelector(EMAIL_SEL, { visible: true, timeout: 30000 });
  } catch (err) {
    // The bare timeout tells us nothing about WHY the form never appeared —
    // an Okta MFA prompt, a bot challenge, a blank proxy error page and a
    // genuinely slow load all look identical. Report what is actually on
    // screen so the next failure is diagnosable from the log alone.
    let diag = "";
    try {
      diag = await page.evaluate(() => {
        const t = (document.body && document.body.innerText || "").trim().replace(/\s+/g, " ");
        const inputs = [...document.querySelectorAll("input")]
          .map((i) => i.id || i.name || i.type).filter(Boolean).join(", ");
        return JSON.stringify({
          url: location.href.slice(0, 160),
          title: (document.title || "").slice(0, 80),
          inputs: inputs.slice(0, 160),
          text: t.slice(0, 240),
        });
      });
    } catch (e) { diag = `(could not read page: ${e.message})`; }
    onLog(`  ✖ login form never appeared — page was: ${diag}`);
    throw err;
  }
  onLog("Typing CRM email");
  await typeInto(page, EMAIL_SEL, credentials.username);
  onLog("Typing CRM password");
  await typeInto(page, PASSWORD_SEL, credentials.password);
  onLog("Clicking Sign In");
  await page.waitForSelector(SUBMIT_SEL, { visible: true, timeout: 15000 });
  await page.click(SUBMIT_SEL);
}

async function waitLeftLoginHost(page, loginHost, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let host = "";
    try { host = new URL(page.url()).host; } catch {}
    if (host && host !== loginHost) {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
      return true;
    }
    await sleep(400);
  }
  return false;
}

// Click the Modern Retail CRM launcher card.
//
// IMPORTANT: the card does NOT navigate the tab. It opens the CRM inside a
// Unify "app-stack" iframe (see #app-stack > .maximized-frame > iframe.appFrame
// in the applications page). That iframe runs an SSO handoff (sso.html → … →
// crm.connectcdk.com) which establishes the CRM session cookies. The top-level
// tab stays on app-unify the whole time. So we click the card here and handle
// the iframe/SSO wait in enterCrm — we do NOT wait for the top-level URL to
// become the CRM host (it never does).
async function clickModernRetailCard(page, onLog = () => {}) {
  onLog("Looking for the Modern Retail CRM card");
  const found = await page
    .waitForFunction(
      (sels) => sels.some((s) => document.querySelector(s)),
      { timeout: 45000 },
      MODERN_RETAIL_CRM_CARD_SELECTORS,
    )
    .then(() => true)
    .catch(() => false);
  if (!found) throw new Error("Modern Retail CRM card never appeared on the applications page");

  // Find the card handle.
  let handle = null;
  for (const sel of MODERN_RETAIL_CRM_CARD_SELECTORS) {
    handle = await page.$(sel).catch(() => null);
    if (handle) break;
  }
  if (!handle) throw new Error("Could not resolve the Modern Retail CRM card element");

  await handle.evaluate((el) => { try { el.scrollIntoView({ block: "center" }); } catch (e) {} });
  await sleep(400);

  // Use a REAL mouse click (CDP-dispatched, isTrusted=true). A DOM .click()
  // inside page.evaluate produces an untrusted event, which SPA launchers can
  // ignore — that is almost certainly why the app never actually launched.
  // We click the card's inner title area to avoid the ⋮ "more" button, which
  // sits in the top-right corner of the card.
  let clicked = false;
  try {
    const box = await handle.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      // Aim left-of-centre, vertically centred: safely away from the ⋮ button.
      const x = box.x + Math.min(box.width * 0.35, box.width - 8);
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y, { steps: 8 });
      await sleep(150);
      await page.mouse.click(x, y, { delay: 60 });
      clicked = true;
      onLog(`  real mouse click at (${Math.round(x)}, ${Math.round(y)})`);
    }
  } catch (err) {
    onLog(`  mouse click failed (${err.message})`);
  }

  // Fallback 1: puppeteer's element click (also a real mouse event).
  if (!clicked) {
    try { await handle.click({ delay: 60 }); clicked = true; onLog("  element.click() used"); }
    catch (err) { onLog(`  element.click() failed (${err.message})`); }
  }

  // Fallback 2: the card is tabindex=0, so keyboard activation should work.
  if (!clicked) {
    try {
      await handle.focus();
      await page.keyboard.press("Enter");
      clicked = true;
      onLog("  keyboard Enter used");
    } catch (err) { onLog(`  keyboard activation failed (${err.message})`); }
  }

  // Fallback 3: last resort, the untrusted DOM click (previous behaviour).
  if (!clicked) {
    clicked = await handle.evaluate((el) => { try { el.click(); return true; } catch (e) { return false; } });
    if (clicked) onLog("  DOM .click() fallback used");
  }

  await handle.dispose().catch(() => {});
  if (!clicked) throw new Error("Could not click the Modern Retail CRM card");
  onLog("Clicked Modern Retail CRM [entry v8]");
}

// After the click, the Unify app-stack iframe appears and loads the CRM.
// Confirm the frame element exists (proves the click launched the app).
async function waitForAppFrame(page, timeout = 30000) {
  return page
    .waitForFunction(
      () =>
        !!document.querySelector(
          '#app-stack iframe.appFrame, iframe[title="Modern Retail CRM"], .maximized-frame iframe',
        ),
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

// Poll every child frame for one on the CRM host. This is BEST-EFFORT only:
// the app frame is an sso.html shim on the Unify origin, and depending on how
// it sandboxes/replaces itself puppeteer often cannot observe it reaching the
// CRM host at all. So we give it a short window purely to let the SSO warm the
// cookie jar, log progress, and move on regardless. The real entry path is the
// direct navigation + SAML wait in enterCrm.
async function waitForCrmFrame(page, crmHost, timeout = 12000, onLog = () => {}) {
  const deadline = Date.now() + timeout;
  // Beat immediately, then every 3s, so this phase is never silent.
  let lastBeat = Date.now();
  onLog(`  … watching the app frame for ${Math.round(timeout / 1000)}s`);
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      let u = "";
      try { u = f.url(); } catch {}
      if (u && u.includes(crmHost)) {
        await sleep(1200);
        let after = "";
        try { after = f.url(); } catch {}
        return after && after.includes(crmHost) ? after : u;
      }
    }
    if (Date.now() - lastBeat > 3000) {
      lastBeat = Date.now();
      const secs = Math.round((deadline - Date.now()) / 1000);
      onLog(`  … app frame SSO not visible yet (${secs}s left, then we continue anyway)`);
    }
    await sleep(500);
  }
  return "";
}

// ── SSO URL discovery ───────────────────────────────────────────────────────
// Clicking the card makes the Unify app frame perform an SP-initiated SAML
// handshake. We can't reliably READ that frame's final URL, but we CAN watch
// the network: every request it issues passes through the page's request event,
// including sub-frame traffic. So we record the SAML entry URL as it flies by
// and reuse it in our own tab — the only way into eLead that establishes a
// session (index.aspx alone just hits login.asp?logout=1).
const SAML_RE = /okta\.com\/app\/[^/]+\/[^/]+\/sso\/saml/i;

function startSsoCapture(page) {
  const saml = [];
  const crm = [];
  const record = (u) => {
    if (!u || typeof u !== "string") return;
    if (SAML_RE.test(u)) { if (!saml.includes(u)) saml.push(u); return; }
    // A CRM URL that isn't the logout/login page is also a usable entry.
    if (u.includes(CRM_HOST) && !/login\.asp|logout=1/i.test(u)) {
      if (!crm.includes(u)) crm.push(u);
    }
  };
  const onRequest = (r) => { try { record(r.url()); } catch {} };
  const onFrameNav = (f) => { try { record(f.url()); } catch {} };
  page.on("request", onRequest);
  page.on("framenavigated", onFrameNav);
  return {
    // Best entry URL found so far: prefer the SAML initiator.
    best() { return saml[0] || crm[0] || ""; },
    counts() { return { saml: saml.length, crm: crm.length }; },
    stop() {
      try { page.off("request", onRequest); } catch {}
      try { page.off("framenavigated", onFrameNav); } catch {}
    },
  };
}

// Wait until the capture has something usable, or the window closes.
async function waitForSsoUrl(capture, timeout = 20000, onLog = () => {}) {
  const deadline = Date.now() + timeout;
  let lastBeat = Date.now();
  onLog(`  … watching the app frame's network for the SSO entry URL (${Math.round(timeout / 1000)}s)`);
  while (Date.now() < deadline) {
    const best = capture.best();
    if (best) return best;
    if (Date.now() - lastBeat > 3000) {
      lastBeat = Date.now();
      const secs = Math.round((deadline - Date.now()) / 1000);
      onLog(`  … no SSO URL seen yet (${secs}s left)`);
    }
    await sleep(400);
  }
  return "";
}

// Race a promise against a timer. Returns `fallback` if it doesn't settle in
// time. Used to guard calls that can hang silently (e.g. newPage under
// puppeteer-real-browser) so a stall becomes a logged, recoverable event.
function withTimeout(promise, ms, fallback) {
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); return v; },
      () => { clearTimeout(timer); return fallback; },
    ),
    guard,
  ]);
}

// Follow a redirect chain (typically Unify → Okta SAML → CRM) until the page
// lands on `host`. Logs a heartbeat with the current host so a slow multi-hop
// SSO is visibly progressing rather than looking like a hang.
async function waitForHost(page, host, timeout = 120000, onLog = () => {}) {
  const deadline = Date.now() + timeout;
  let lastBeat = 0;
  let lastSeen = "";
  while (Date.now() < deadline) {
    let h = "";
    try { h = new URL(page.url()).host; } catch {}
    if (h === host) return true;
    if (h && h !== lastSeen) {
      lastSeen = h;
      onLog(`  … signing in via ${h}`);
      lastBeat = Date.now();
    } else if (Date.now() - lastBeat > 8000) {
      lastBeat = Date.now();
      const secs = Math.round((deadline - Date.now()) / 1000);
      onLog(`  … still on ${h || "about:blank"} (${secs}s left)`);
    }
    await sleep(1000);
  }
  return false;
}

/**
 * Full entry sequence. Leaves the Unify tab open (it anchors the eLead session)
 * and returns a SECOND tab sitting inside the CRM, ready for the scrape
 * pipeline.
 *
 * @param {import('puppeteer').Page} page  the Unify tab
 * @param {{username:string,password:string}} credentials  CRM login
 * @param {object} opts { restored, onLog }
 * @returns {Promise<{loggedIn:boolean, page:import('puppeteer').Page, unifyPage:import('puppeteer').Page}>}
 *          `page` is the CRM tab to scrape with; `unifyPage` must stay open.
 */
export async function enterCrm(page, credentials, { restored = false, onLog = () => {} } = {}) {
  onLog(`Opening Unify: ${UNIFY_APP_URL}`);
  await safeNavigate(page, UNIFY_APP_URL);

  const settled = await waitForSettle(page);
  let loggedIn = false;

  if (settled.state === "login") {
    if (restored) onLog("Saved session not accepted — signing in");
    const loginHost = new URL(page.url()).host;
    await submitLogin(page, credentials, onLog);
    onLog("Waiting to leave the login host");
    const ok = await waitLeftLoginHost(page, loginHost);
    if (!ok) throw new Error("Sign-in did not complete (MFA or rejected credentials)");
    loggedIn = true;
    // Land back on the applications page.
    await waitForLoad(page, 20000);
  } else {
    onLog("Already signed in — session restored");
  }

  // Make sure we're on the applications launcher before clicking the card.
  let host = "";
  try { host = new URL(page.url()).host; } catch {}
  if (host !== APP_HOST) {
    await safeNavigate(page, UNIFY_APP_URL);
    await waitForLoad(page, 20000);
  }

  // Click into Modern Retail CRM. The CRM opens INSIDE a Unify app-stack iframe
  // (an sso.html shim) — the top-level tab does NOT navigate.
  //
  // CRITICAL: do NOT navigate THIS tab to the CRM. eLead's session is anchored
  // to the Unify tab hosting the SSO iframe; navigating it away tears the frame
  // down and eLead logs the session out. The Unify tab stays open all run.
  //
  // The card click is BEST-EFFORT: it warms the app's SSO. The reliable entry
  // is opening a second tab straight at the CRM and letting Okta's SAML chain
  // sign us in (Okta already holds our session from the Unify login). That path
  // works on its own, so a card/frame hiccup must never block the run.
  // Start watching the network BEFORE the click, so we catch the SAML entry
  // URL the app frame requests during its handshake.
  const capture = startSsoCapture(page);
  let ssoUrl = "";
  try {
    await clickModernRetailCard(page, onLog);
    const appFrameUp = await waitForAppFrame(page, 15000);
    onLog(appFrameUp ? "App frame detected" : "App frame not detected — continuing");
    ssoUrl = await waitForSsoUrl(capture, 20000, onLog);
  } catch (err) {
    onLog(`Card launch not usable (${err.message})`);
  } finally {
    capture.stop();
  }

  if (ssoUrl) {
    onLog(`Discovered SSO entry: ${ssoUrl.slice(0, 110)}${ssoUrl.length > 110 ? "…" : ""}`);
  } else if (CRM_SSO_URL) {
    ssoUrl = CRM_SSO_URL;
    onLog("Using CRM_SSO_URL from .env as the SSO entry");
  } else {
    throw new Error(
      "Could not discover the CRM SSO entry URL. eLead cannot be opened by URL " +
      "alone (index.aspx redirects to login.asp?logout=1). Open the CRM manually, " +
      "copy the connectcdk.okta.com/app/.../sso/saml URL from the address bar, and " +
      "set CRM_SSO_URL in .env.",
    );
  }

  // Open a second tab and enter through SSO. The Unify tab stays open as the
  // session anchor. We NEVER navigate straight to index.aspx — that is the
  // logout path.
  onLog("Opening a second tab for the CRM…");
  const context = page.browserContext();
  let crmPage = await withTimeout(context.newPage(), 20000, null);
  if (!crmPage) {
    onLog("  context.newPage() stalled — falling back to browser.newPage()");
    crmPage = await withTimeout(page.browser().newPage(), 20000, null);
  }
  if (!crmPage) throw new Error("Could not open a new tab for the CRM (browser unresponsive)");
  // Block popups (e.g. the desking "Vehicle Search" window) before any nav.
  await armPage(crmPage, onLog);
  onLog("  second tab open");

  // Clear any crm.connectcdk.com cookies first. A stale/expired eLead SESSIONID
  // makes eLead answer with login.asp?logout=1 instead of accepting the SAML
  // assertion — the exact failure a fresh browser never hits.
  const clearCrmCookies = async () => {
    try {
      const cdp = await crmPage.createCDPSession();
      await cdp.send("Network.enable").catch(() => {});
      const { cookies = [] } = await cdp.send("Network.getAllCookies").catch(() => ({ cookies: [] }));
      const stale = cookies.filter((c) =>
        String(c.domain || "").replace(/^\./, "").toLowerCase().includes(CRM_HOST.toLowerCase()));
      for (const c of stale) {
        await cdp.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path })
          .catch(() => {});
      }
      if (stale.length) onLog(`  cleared ${stale.length} stale ${CRM_HOST} cookie(s)`);
      await cdp.detach().catch(() => {});
    } catch {}
  };

  // When the SAML chain parks on Okta it is usually an auto-POST form that
  // never fired (the page renders, but its onload submit didn't run). Nudge it
  // by submitting the form / clicking the submit control. Harmless otherwise.
  const nudgeSamlForm = async () => {
    try {
      const did = await crmPage.evaluate(() => {
        const btn = document.querySelector(
          'input[type="submit"], button[type="submit"], #appForm input[type="submit"]');
        if (btn) { btn.click(); return "clicked submit"; }
        const form = document.forms && document.forms[0];
        if (form && (form.action || "").length) { form.submit(); return "submitted form"; }
        return "";
      });
      if (did) onLog(`  nudged the SAML page (${did})`);
      return !!did;
    } catch { return false; }
  };

  // Enter through SSO with a SHORT wait and quick retries. Waiting minutes on
  // Okta never recovers; a fresh SSO navigation usually does.
  let landed = false;
  for (let attempt = 1; attempt <= SSO_ATTEMPTS && !landed; attempt++) {
    if (attempt > 1) onLog(`Retrying through the SSO entry (attempt ${attempt}/${SSO_ATTEMPTS})`);
    else onLog("Entering the CRM through SSO…");

    await clearCrmCookies();
    await safeNavigate(crmPage, ssoUrl);
    landed = await waitForHost(crmPage, CRM_HOST, SSO_WAIT_MS, onLog);

    if (!landed) {
      let h = "";
      try { h = new URL(crmPage.url()).host; } catch {}
      onLog(`  did not reach ${CRM_HOST} within ${Math.round(SSO_WAIT_MS / 1000)}s (stuck on ${h || "about:blank"})`);
      // If we're parked on the IdP, try nudging its form once before retrying.
      if (/okta|sso|saml|idp/i.test(h)) {
        if (await nudgeSamlForm()) {
          landed = await waitForHost(crmPage, CRM_HOST, Math.min(SSO_WAIT_MS, 10000), onLog);
        }
      }
      if (!landed && attempt < SSO_ATTEMPTS) await sleep(2000);
    }
  }
  await waitForLoad(crmPage, 30000);
  if (!landed) onLog("SSO did not reach the CRM host after all attempts");

  // Report WHY we're off the CRM, not just that we are. Chrome's network error
  // pages (ERR_TUNNEL_CONNECTION_FAILED etc.) render instantly, which otherwise
  // looks identical to "SAML didn't finish" — but needs a totally different fix.
  const describe = async () => {
    let url = "";
    try { url = crmPage.url(); } catch {}
    let diag = "";
    try {
      diag = await crmPage.evaluate(() => {
        const t = (document.body && document.body.innerText || "").trim().slice(0, 200);
        const err = (t.match(/ERR_[A-Z_]+/) || [])[0] || "";
        return err ? `${err}` : (document.title || t.split("\n")[0] || "").slice(0, 120);
      });
    } catch {}
    return `${url || "about:blank"}${diag ? ` — ${diag}` : ""}`;
  };

  const offCrm = async () => {
    let h = "", u = "";
    try { u = crmPage.url(); h = new URL(u).host; } catch {}
    // login.asp / logout=1 means the SSO did not establish a session.
    if (/login\.asp|logout=1/i.test(u)) return true;
    return h !== CRM_HOST || (await looksLikeLoginDom(crmPage));
  };
  if (await offCrm()) {
    const where = await describe();
    try { await crmPage.close(); } catch {}
    throw new Error(`Could not open the CRM signed in — at: ${where}`);
  }

  // Signed in. Now it is safe to move to the eLead index if SSO parked us
  // elsewhere inside the CRM — the session exists, so this will not log out.
  let hereUrl = "";
  try { hereUrl = crmPage.url(); } catch {}
  if (!/elead_track/i.test(hereUrl)) {
    onLog("Navigating to the eLead track index (session established)");
    await safeNavigate(crmPage, ELEAD_INDEX_URL);
    await waitForLoad(crmPage, 30000);
    if (await offCrm()) {
      const where = await describe();
      try { await crmPage.close(); } catch {}
      throw new Error(`Lost the CRM session moving to the index — at: ${where}`);
    }
  }

  onLog(`Inside the CRM: ${crmPage.url()}`);
  // Hand back the CRM tab for the pipeline; keep the Unify tab open (session
  // anchor) — the caller closes the whole browser at the end of the store.
  return { loggedIn, page: crmPage, unifyPage: page };
}
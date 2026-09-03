// ---------------------------------------------------------------------------
// src/scrape/leadScraper.js — scrape one lead across all its pages.
//
// This is the puppeteer port of background.js::scrapeLeadAllPages. The DOM
// extraction is UNCHANGED — it's the injected content.js functions
// (window.__gp.scrapeMainPage, .findAllSubPageUrls, .scrapeAnyPage,
// .listLeadPageTabs, .clickLeadPageTab, .scrapeTabIframe, .scrapeTextMessages
// Page, plus the CallDrip type resolver). What changes is the plumbing:
// chrome.tabs.sendMessage → page.evaluate, executeInAllFrames →
// evaluateInAllFrames, safeNavigate/waitForLoad → the inject.js equivalents.
//
// The result object is identical in shape to what the extension sent to the
// server, so /api/process-lead consumes it unchanged.
// ---------------------------------------------------------------------------
import {
  sleep,
  safeNavigate,
  waitForLoad,
  ensureAssets,
  ensureAssetsAllFrames,
  evaluateInAllFrames,
  evaluateInMainFrame,
  rehostUrl,
} from "./inject.js";
import {
  HISTORY_WINDOW_DAYS,
  PRIOR_OPP_WINDOW_DAYS,
  HISTORY_MAX_CELL_CHARS,
} from "../config.js";

function countFields(obj, d = 0) {
  if (!obj || d > 4) return 0;
  let c = 0;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) c += countFields(v, d + 1);
    else if (Array.isArray(v)) c += v.length;
    else if (v !== "" && v !== null && v !== undefined && v !== false) c++;
  }
  return c;
}

// Resolve CallDrip agent → type against the page's sales team, using the
// injected content.js matcher (single implementation, same as the extension's
// RESOLVE_CALLDRIP_TYPES handler).
async function resolveCallDripTypes(page, entries, extraReps = []) {
  return evaluateInMainFrame(page, (ents, extra) => {
    if (!window.__gp || !window.__gp.getSalesReps) return [];
    const index = window.__gp
      .buildRepIndex(window.__gp.getSalesReps(window.__gp.getSalesTeam()), 0)
      .concat(window.__gp.buildRepIndex(extra || [], 1));
    return (ents || []).map((e) => {
      const who = window.__gp.resolveRepType(e && e.agentName, index);
      return {
        url: (e && e.url) || "",
        callId: window.__gp.callDripIdFromUrl(e && e.url),
        type: who.type, repType: who.repType, agentName: who.agentName,
        matchedRepName: who.matchedRepName, role: who.role, typeSource: who.typeSource,
      };
    });
  }, [entries, extraReps]);
}

// Pull name→role pairs from the Audit Trail tab text (extension parity).
function extractRepsFromAuditTrail(subPages) {
  const out = [];
  const seen = new Set();
  const NAME = "([A-Za-z][A-Za-z.'\\-]*(?:\\s+[A-Za-z][A-Za-z.'\\-]*){0,3})";
  const ROLE = "([A-Za-z][A-Za-z&/\\-]*(?:\\s+[A-Za-z][A-Za-z&/\\-]*){0,3})";
  const patterns = [
    new RegExp("\\bAdded\\s+" + NAME + "\\s+to the sales team as an?\\s+" + ROLE, "gi"),
    new RegExp("\\bRemoved\\s+" + NAME + "\\s+from the sales team as an?\\s+" + ROLE, "gi"),
  ];
  for (const pageData of subPages || []) {
    const type = pageData && pageData.pageType;
    if (type !== "tab_audittrail" && type !== "tab_golddigger2") continue;
    const blob = String(pageData.fullText || "");
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(blob)) !== null) {
        const name = (m[1] || "").trim().replace(/\s+/g, " ");
        const role = (m[2] || "").trim().replace(/\s+/g, " ");
        if (!name || name.length > 60 || !role) continue;
        const key = name.toLowerCase() + "|" + role.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, role, source: "audit-trail" });
      }
    }
  }
  return out;
}

// Scrape every tab on the lead page (Contacts, Service, Audit Trail, …). Tabs
// swap an iframe, so we click each and read #tabsTargetFrame's content via the
// injected scrapeTabIframe. Mirrors background.js::scrapeAllTabs.
async function scrapeAllTabs(page, scrapeMode, onLog) {
  const tabsScraped = [];
  await ensureAssets(page);
  const tabs = await evaluateInMainFrame(page, () =>
    (window.__gp && window.__gp.listLeadPageTabs) ? window.__gp.listLeadPageTabs() : []);
  let list = tabs || [];
  if (!list.length) return tabsScraped;

  if (scrapeMode === "recheck") {
    list = list.filter((t) => t.id === "liContacts" || /contacts/i.test(t.label || ""));
  }

  for (const t of list) {
    try {
      const clicked = await evaluateInMainFrame(page, (id) =>
        (window.__gp && window.__gp.clickLeadPageTab) ? window.__gp.clickLeadPageTab(id) : false, [t.id]);
      if (!clicked) continue;
      await sleep(2000);

      let data = await evaluateInMainFrame(page, () =>
        (window.__gp && window.__gp.scrapeTabIframe) ? window.__gp.scrapeTabIframe() : { error: "no fn" });
      if (!data || data.error) {
        await sleep(2000);
        data = await evaluateInMainFrame(page, () =>
          (window.__gp && window.__gp.scrapeTabIframe) ? window.__gp.scrapeTabIframe() : { error: "no fn" });
      }
      if (!data || data.error) continue;

      tabsScraped.push({
        ...data,
        pageType: "tab_" + t.id.replace(/^li/, "").toLowerCase(),
        pageUrl: data.iframeUrl || "",
        pageTitle: "Tab: " + t.label,
        tabLabel: t.label,
        tabLiId: t.id,
      });
    } catch (err) {
      onLog(`    ⚠ tab ${t.label}: ${err.message}`);
    }
  }
  // Restore Contacts.
  try {
    await evaluateInMainFrame(page, () =>
      window.__gp && window.__gp.clickLeadPageTab && window.__gp.clickLeadPageTab("liContacts"));
    await sleep(500);
  } catch {}
  return tabsScraped;
}

/**
 * Scrape one lead (main page + tabs + all sub-pages). `lead` needs { url,
 * dealId, personId?, name? }. Returns { mainData, subPages, allUrls }.
 * Mirrors background.js::scrapeLeadAllPages including the CallDrip sweep,
 * the passive SoldHistory URL discovery, and the recheck-mode sub-page filter.
 */
export async function scrapeLeadAllPages(page, lead, config = {}, scrapeMode = "full", recheckOpts = {}, onLog = () => {}) {
  const allUrls = [{ url: rehostUrl(lead.url), type: "prospect", label: "Prospect / Lead Detail" }];
  const subPages = [];

  // ── Main page ──
  await ensureAssets(page);
  const mainData = await evaluateInMainFrame(page, () =>
    (window.__gp && window.__gp.scrapeMainPage) ? window.__gp.scrapeMainPage() : null);
  if (!mainData) return { mainData: null, subPages: [], allUrls };

  // ── CallDrip sweep across all frames (activity log lives in an iframe) ──
  try {
    const allCdActivities = mainData.activityLog || [];
    // HISTORY SCOPE — this sweep runs in EVERY frame, including ones where
    // content.js was never injected, so it cannot call gpKeepActivityRow().
    // The same rules are re-implemented inline and the inputs are passed in:
    //   • rows inside the CURRENT deal's block (td#div_<dealId>) always pass
    //   • rows inside a PRIOR block pass only if that block's header date is
    //     within priorDays
    //   • ungrouped rows fall back to the date window
    //   • mega rows (flattened child-table dumps) never pass
    // Without this the sweep silently re-imports everything content.js just
    // scoped out.
    const cutoffMs = Date.now() - HISTORY_WINDOW_DAYS * 86400000;
    const priorCutoffMs = Date.now() - PRIOR_OPP_WINDOW_DAYS * 86400000;
    const currentDealId = String(lead.dealId || mainData.dealId || "");
    const cdResults = await evaluateInAllFrames(page, (cutoff, priorCutoff, maxCell, dealId) => {
      // Anchors: row.textContent concatenates cells with no separator, so \b
      // on either end of this pattern fails and the date is never found. Use a
      // digit-lookbehind at the front and no anchor at the back.
      const DT = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP])M/gi;
      const newestMs = (text) => {
        const s = String(text || ""); DT.lastIndex = 0;
        let best = null, m;
        while ((m = DT.exec(s)) !== null) {
          let yr = parseInt(m[3], 10); if (yr < 100) yr += 2000;
          let hr = parseInt(m[4], 10); const ap = (m[6] || "").toUpperCase();
          if (ap === "P" && hr < 12) hr += 12;
          if (ap === "A" && hr === 12) hr = 0;
          const t = new Date(yr, parseInt(m[1], 10) - 1, parseInt(m[2], 10), hr, parseInt(m[5], 10)).getTime();
          if (!isNaN(t) && (best === null || t > best)) best = t;
        }
        return best;
      };
      const dateCount = (text) => {
        const s = String(text || ""); DT.lastIndex = 0;
        let n = 0; while (DT.exec(s) !== null) n++; return n;
      };
      // "External" means not the CRM, on ANY of its hosts. The old test was
      // !h.includes("eleadcrm.com"), which stopped matching after the move to
      // crm.connectcdk.com — internal eLead links started being reported as
      // external, and externalUrls[0] feeds callDripUrl.
      const isCrmUrl = (u) => {
        try {
          return /(?:^|\.)(?:eleadcrm\.com|connectcdk\.com)$/i
            .test(new URL(String(u || ""), location.href).hostname);
        } catch (e) { return false; }
      };
      const oppIdOfHeader = (row) => {
        const ic = row.querySelector('[id^="img_"]');
        if (ic && /^img_\d+$/.test(ic.id || "")) return ic.id.slice(4);
        const nodes = [row, ...row.querySelectorAll("[onclick]")];
        for (const n of nodes) {
          const m = ((n.getAttribute && n.getAttribute("onclick")) || "")
            .match(/swapDiv\s*\(\s*['"]?(\d+)['"]?\s*\)/);
          if (m) return m[1];
        }
        return "";
      };
      // Plan the opportunity blocks in THIS frame.
      const dropOpp = new Set();
      const headers = [...document.querySelectorAll("tr.PageHeaderContacts")];
      let anchored = false;
      const decided = headers.map((row) => {
        const id = oppIdOfHeader(row);
        const when = newestMs(row.textContent || "");
        let keep;
        if (dealId && id && id === dealId) { keep = true; anchored = true; }
        else keep = (when !== null && when >= priorCutoff);
        return { row, id, keep };
      });
      if (!anchored && decided.length) decided[0].keep = true;   // fallback
      for (const d of decided) if (!d.keep && d.id) dropOpp.add(d.id);

      // eLead nests a layout <table> inside the Activity Type cell; those inner
      // <tr>s are duplicates of their parent's text with no date and no
      // opportunity, so they survive every filter — including when the parent
      // row was correctly dropped. Reject by ancestry.
      const nestedLayout = (row) => {
        const td = row.parentElement && row.parentElement.closest && row.parentElement.closest("td");
        return !!td && !/^div_\d+$/.test(td.id || "");
      };
      const rowOk = (row) => {
        if (!row) return true;
        if (nestedLayout(row)) return false;
        const cells = [...row.querySelectorAll("td")].map((c) => (c.textContent || "").trim());
        for (const c of cells) if (c.length > maxCell) return false;      // mega row
        const text = (row.textContent || "").replace(/\s+/g, " ");
        if (dateCount(text) >= 3) return false;                           // mega row
        if (row.classList && row.classList.contains("PageHeaderContacts")) {
          return !dropOpp.has(oppIdOfHeader(row));
        }
        const box = row.closest && row.closest('td[id^="div_"]');
        if (box && /^div_\d+$/.test(box.id || "")) {
          const oid = box.id.slice(4);
          return !dropOpp.has(oid);          // in a kept deal → no date filter
        }
        const when = newestMs(text);         // ungrouped → date window
        return when === null ? true : when >= cutoff;
      };
      const urls = []; const activities = [];
      const agentOf = (row) => {
        if (!row) return "";
        const cell = [...row.querySelectorAll("td.completedBy, .completedBy")].find((c) => c.closest("tr") === row);
        if (!cell) return "";
        const title = cell.getAttribute("title") || "";
        const m = title.match(/Completed\s*By\s*:\s*([^\n\r]+)/i);
        const raw = (m && m[1]) || cell.textContent || "";
        return raw.trim().replace(/\s+/g, " ");
      };
      const push = (url, agentName) => {
        if (!url) return;
        const hit = urls.find((u) => u.url === url);
        if (!hit) urls.push({ url, agentName: agentName || "" });
        else if (!hit.agentName && agentName) hit.agentName = agentName;
      };
      document.querySelectorAll('a[href*="calldrip"]').forEach((a) => {
        const href = a.href || "";
        if (href.includes("calldrip")) {
          const row = a.closest("tr");
          if (!rowOk(row)) return;
          push(href, agentOf(row));
          if (row) {
            const cells = [...row.querySelectorAll("td")].map((c) => c.textContent?.trim()).filter(Boolean);
            activities.push({ url: href, cells, text: row.textContent?.trim()?.replace(/\s+/g, " ") });
          }
        }
      });
      document.querySelectorAll("table tr").forEach((row) => {
        if (!/calldrip/i.test(row.textContent || "")) return;
        if (!rowOk(row)) return;
        const agent = agentOf(row);
        if (!agent) return;
        const found = (row.innerHTML || "").matchAll(/https?:\/\/(?:[\w-]+\.)*calldrip\.com\/[^\s"'<>)]+/gi);
        for (const m of found) push(m[0].replace(/[.,;]+$/, ""), agent);
      });
      // The old whole-body regex sweep lived here. It had no row context, so
      // no date and no agent — it was the single biggest source of lifetime
      // call re-import, undoing both passes above. Removed deliberately; the
      // two row-scoped passes already cover href links AND bare-text URLs.
      document.querySelectorAll("table tr").forEach((row) => {
        const t = row.textContent || "";
        if (/(?:Outbound|Inbound|Missed|Possible)\s*(?:Call|Phone)/i.test(t)) {
          if (!rowOk(row)) return;
          const cells = [...row.querySelectorAll("td")].map((c) => c.textContent?.trim()).filter(Boolean);
          const links = [...row.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => h && h.startsWith("http") && !isCrmUrl(h));
          activities.push({ url: links[0] || "", cells, text: t.trim().replace(/\s+/g, " "), externalUrls: links });
        }
      });
      return { urls, activities };
    }, [cutoffMs, priorCutoffMs, HISTORY_MAX_CELL_CHARS, currentDealId]);

    const cdByUrl = new Map();
    const urlOf = (u) => (typeof u === "string" ? u : (u && u.url) || "");
    const hasType = (u) => !!(u && typeof u === "object" && u.typeSource && u.typeSource !== "no-agent");
    for (const u of mainData.callDripUrls || []) { const k = urlOf(u); if (k) cdByUrl.set(k, u); }
    const needResolve = [];
    for (const frame of cdResults) {
      if (!frame.result) continue;
      for (const entry of frame.result.urls || []) {
        const k = urlOf(entry); if (!k) continue;
        const existing = cdByUrl.get(k);
        if (hasType(existing)) continue;
        if (entry.agentName) needResolve.push({ url: k, agentName: entry.agentName });
        if (!existing) cdByUrl.set(k, { url: k, agentName: entry.agentName || "" });
      }
      (frame.result.activities || []).forEach((a) => {
        if (!allCdActivities.find((x) => x.text === a.text)) allCdActivities.push(a);
      });
    }
    if (needResolve.length) {
      const resolved = await resolveCallDripTypes(page, needResolve);
      for (const r of resolved || []) if (r.url) cdByUrl.set(r.url, { ...(cdByUrl.get(r.url) || {}), ...r });
    }
    mainData.callDripUrls = [...cdByUrl.values()];
    mainData.activityLog = allCdActivities;
  } catch (err) {
    onLog(`CallDrip scan error: ${err.message}`);
  }

  // ── Lead-page tabs ──
  const tabPages = await scrapeAllTabs(page, scrapeMode, onLog);
  if (tabPages.length) subPages.push(...tabPages);

  // ── Re-type CallDrip from Audit Trail roles (extension parity) ──
  try {
    const auditReps = extractRepsFromAuditTrail(subPages);
    if (auditReps.length) {
      const needs = (e) => e && typeof e === "object" && e.agentName &&
        (!e.typeSource || e.typeSource === "unmatched" || e.typeSource === "no-team" || e.type === "other");
      const pending = [];
      for (const u of mainData.callDripUrls || []) if (needs(u)) pending.push({ url: u.url, agentName: u.agentName });
      for (const a of mainData.activityLog || []) if (needs(a) && a.callDripUrl) pending.push({ url: a.callDripUrl, agentName: a.agentName || a.completedBy });
      if (pending.length) {
        const resolved = await resolveCallDripTypes(page, pending, auditReps);
        const byUrl = new Map();
        for (const r of resolved || []) if (r.url) byUrl.set(r.url, r);
        const apply = (entry, url) => {
          const r = byUrl.get(url);
          if (!r || r.type === "other") return;
          entry.type = r.type; entry.repType = r.repType; entry.matchedRepName = r.matchedRepName;
          entry.role = r.role; entry.typeSource = r.typeSource;
        };
        for (const u of mainData.callDripUrls || []) if (needs(u)) apply(u, u.url);
        for (const a of mainData.activityLog || []) if (needs(a) && a.callDripUrl) apply(a, a.callDripUrl);
      }
    }
  } catch {}

  // ── Discover sub-page URLs (injected findAllSubPageUrls) ──
  let subUrlObjects = await evaluateInMainFrame(page, () =>
    (window.__gp && window.__gp.findAllSubPageUrls) ? window.__gp.findAllSubPageUrls() : []) || [];

  // Passive SoldHistory URL discovery across frames (no clicks).
  try {
    const soldUrls = await evaluateInAllFrames(page, () => {
      const urls = [];
      // Build against the origin actually serving the CRM, not a baked-in host.
      const origin = (function () {
        try { if (window.__gpCrmOrigin) return String(window.__gpCrmOrigin).replace(/\/+$/, ""); } catch (e) {}
        try {
          if (location && location.origin &&
              /(?:^|\.)(?:eleadcrm\.com|connectcdk\.com)$/i.test(location.hostname)) {
            return location.origin;
          }
        } catch (e) {}
        return "https://www.eleadcrm.com";
      })();
      const base = origin + "/evo2/fresh/elead-v45/elead_track/newprospects/SoldHistory.asp";
      let licid = "";
      try { if (typeof gData !== "undefined" && gData) licid = gData.CompanyId || gData.ChildCompanyId || ""; } catch (e) {}
      if (!licid) { const p = new URLSearchParams(window.location.search); licid = p.get("LICID") || p.get("lChildCompanyID") || ""; }
      document.querySelectorAll('[onclick*="doSoldHistory"]').forEach((el) => {
        const m = (el.getAttribute("onclick") || "").match(/doSoldHistory\s*\(\s*(\d+)\s*\)/);
        if (!m) return;
        let url = base + "?"; if (licid) url += "LICID=" + licid + "&"; url += "ID=" + m[1];
        urls.push(url);
      });
      document.querySelectorAll('[onclick*="SoldHistory"], a[href*="SoldHistory"]').forEach((el) => {
        const blob = (el.getAttribute("onclick") || "") + " " + (el.getAttribute("href") || "");
        const m = blob.match(/SoldHistory\.asp\?[^"'\s)<>]+/i);
        if (!m) return;
        let path = m[0].replace(/\\/g, "");
        let full = path;
        if (path.startsWith("../")) full = origin + "/evo2/fresh/elead-v45/elead_track/" + path.replace(/^\.\.\//, "");
        else if (path.startsWith("/")) full = origin + path;
        else if (!/^https?:/i.test(path)) full = origin + "/evo2/fresh/elead-v45/elead_track/newprospects/" + path;
        if (/ID=\d+/i.test(full)) urls.push(full);
      });
      return urls;
    });
    for (const frame of soldUrls) {
      if (frame.result && Array.isArray(frame.result)) {
        frame.result.forEach((url) => {
          const clean = url.split("#")[0];
          if (!subUrlObjects.find((s) => s.url === clean)) {
            subUrlObjects.push({ url: clean, type: "soldHistory", label: "Sold / Purchase History" });
          }
        });
      }
    }
  } catch {}

  // Keep only the most-recent SoldHistory; dedupe; drop the main URL.
  let foundSold = false;
  subUrlObjects = subUrlObjects.filter((item) => {
    if (item.type === "soldHistory") { if (foundSold) return false; foundSold = true; }
    return true;
  });
  const mainUrlBase = rehostUrl(lead.url).split("#")[0].split("&R=")[0];
  const seenUrls = new Set([mainUrlBase]);
  subUrlObjects = subUrlObjects.filter((item) => {
    const b = rehostUrl(item.url).split("#")[0].split("&R=")[0];
    if (seenUrls.has(b)) return false;
    seenUrls.add(b);
    return true;
  });

  // Recheck-mode sub-page filter.
  if (scrapeMode === "recheck") {
    const wantQuote = !!recheckOpts.wantQuote;
    const wantSold = recheckOpts.wantSold !== false;
    subUrlObjects = subUrlObjects.filter((item) => {
      const t = (item.type || "").toLowerCase();
      const u = (item.url || "").toLowerCase();
      if (t === "textmessages" || /messengerclient|textmessagechat/.test(u)) return true;
      if ((t === "soldhistory" || /soldhistory\.asp/.test(u)) && wantSold) return true;
      if ((t === "quote" || /legacyquote/.test(u)) && wantQuote) return true;
      return false;
    });
  }

  // ── Navigate to each sub-page and scrape ──
  for (const { url: rawUrl, type: urlType, label: urlLabel } of subUrlObjects) {
    const subUrl = rehostUrl(rawUrl);
    const isQuote = /legacyquote/i.test(subUrl);
    const isMessenger = urlType === "textMessages" || /MessengerClient|TextMessageChat/i.test(subUrl);
    const slow = isQuote || isMessenger;
    const pageDelay = slow ? Math.max(config.delay || 3000, 5000) : config.delay || 3000;
    const pageTimeout = slow ? 25000 : 15000;
    const maxAttempts = slow ? 2 : 1;

    let subData = null;
    for (let attempt = 1; attempt <= maxAttempts && !subData; attempt++) {
      await safeNavigate(page, subUrl);
      await sleep(pageDelay);
      await waitForLoad(page, pageTimeout);
      await sleep(isMessenger ? 4000 : isQuote ? 2500 : 1500);

      const cur = await evaluateInMainFrame(page, () => window.location.href);
      if (!cur || !/connectcdk\.com|eleadcrm\.com/.test(cur)) break;
      if (/AutoLoginError|errorCode|\/login|\/error|access.denied/i.test(cur)) break;

      // The Quote/Desking page redirects to the desking Inventory Search when
      // the lead has NO saved quote yet (eLead sends you to pick a vehicle,
      // pre-filled from the lead: year/make/model, credit score, trade fields).
      // That page is not this lead's quote — scraping it would store inventory
      // listings as quote data. Treat it as "no quote" and move on.
      if (/InventorySearch|\/desking\/pages\/(?!legacyquote)/i.test(cur)) {
        onLog(`    ↷ no quote on file (desking redirected to inventory search) — skipping`);
        break;
      }

      await ensureAssets(page);
      await sleep(300);
      const d = await evaluateInMainFrame(page, () =>
        (window.__gp && window.__gp.scrapeAnyPage) ? window.__gp.scrapeAnyPage() : null);
      if (d && countFields(d) > 2) subData = d;
    }
    if (subData) {
      subPages.push(subData);
      allUrls.push({ url: subUrl, type: urlType, label: urlLabel });
    }
  }

  return { mainData, subPages, allUrls };
}

// Collect lead links from a list page (drilldown or folder) via the injected
// collector, with the same fallback the extension used. Returns [{personId,
// dealId, name, url}].
export async function scrapeLeadsList(page) {
  await ensureAssetsAllFrames(page);
  const perFrame = await evaluateInAllFrames(page, () => {
    if (window.__gp && window.__gp.collectLeadLinksFromPage) {
      try { return window.__gp.collectLeadLinksFromPage(); } catch (e) {}
    }
    // ── Fallback: window.__gp was unavailable in this frame ──
    // Kept at PARITY with content.js::collectLeadLinksFromPage, which this
    // mirrors. Three things it used to get wrong:
    //   1. it always synthesized the URL and threw the real href away, so a
    //      path change in eLead would break every link while the observed
    //      href kept working. Now the href wins when it is usable.
    //   2. it hard-coded www.eleadcrm.com. Now it builds against the origin
    //      actually serving the page.
    //   3. first-anchor-wins took that anchor's TEXT as the lead name, so a
    //      grid row whose date cell links to the lead yielded name "9/02/26".
    //      Now the best candidate across a lead's anchors wins.
    const origin = (function () {
      try { if (window.__gpCrmOrigin) return String(window.__gpCrmOrigin).replace(/\/+$/, ""); } catch (e) {}
      try {
        if (location && location.origin &&
            /(?:^|\.)(?:eleadcrm\.com|connectcdk\.com)$/i.test(location.hostname)) {
          return location.origin;
        }
      } catch (e) {}
      return "https://www.eleadcrm.com";
    })();
    // The discriminator for "is this a person's name" is DIGITS. A name
    // effectively never has them; a date ("9/02/26"), a vehicle ("2026 Jeep
    // Grand Wagoneer"), a stock number and a dollar amount all do.
    const looksLikeName = (t) => {
      const v = String(t || "").trim();
      if (v.length < 2 || v.length > 80) return false;
      if (/\d/.test(v)) return false;
      if (!/[A-Za-z]{2}/.test(v)) return false;
      return !/^(?:N|U|Y|New|Sold|Active|Inactive|Open|Closed|Quote|Delivered|Unknown)$/i.test(v);
    };
    const byKey = new Map();
    document.querySelectorAll('a[href*="lPID"], a[href*="OpptyDetails"], [onclick*="OpptyDetails"]').forEach((el) => {
      const source = (el.href || "") + (el.getAttribute("onclick") || "");
      const pid = source.match(/lPID=(\d+)/i);
      const did = source.match(/lDID=(\d+)/i);
      if (!pid || !did) return;
      const key = pid[1] + "-" + did[1];
      const text = (el.textContent || "").trim().replace(/\s+/g, " ").substring(0, 80);
      const href = el.href || "";
      const usableHref = /OpptyDetails/i.test(href) && /^https?:/i.test(href);

      let rec = byKey.get(key);
      if (!rec) {
        rec = {
          personId: pid[1], dealId: did[1], name: "",
          url: origin + "/evo2/fresh/elead-v45/elead_track/NewProspects/OpptyDetails.aspx"
             + "?lPID=" + pid[1] + "&lDID=" + did[1] + "&loc=DeskLogDLL&R=NO&LICID=",
          _fromHref: false,
        };
        byKey.set(key, rec);
      }
      // Prefer the URL eLead itself rendered — it carries the real loc/LICID
      // and survives a path change that would break the synthesized shape.
      if (usableHref && !rec._fromHref) { rec.url = href; rec._fromHref = true; }
      // Best name across this lead's anchors: longest digit-free candidate.
      // Fall back to scanning the row when no anchor text qualifies.
      if (looksLikeName(text) && text.length > rec.name.length) rec.name = text;
      if (!rec.name && el.closest) {
        const row = el.closest("tr");
        if (row) {
          for (const c of row.querySelectorAll("td")) {
            const t = (c.textContent || "").trim().replace(/\s+/g, " ").substring(0, 80);
            if (looksLikeName(t) && t.length > rec.name.length) rec.name = t;
          }
        }
      }
    });
    const leads = [...byKey.values()].map(({ _fromHref, ...l }) => ({
      ...l, name: l.name || "Unknown",
    }));
    return leads;
  });
  const all = [];
  for (const f of perFrame) if (Array.isArray(f.result)) all.push(...f.result);
  const unique = {};
  for (const l of all) { const k = l.personId + "_" + l.dealId; if (!unique[k]) unique[k] = { ...l, url: rehostUrl(l.url) }; }
  return Object.values(unique);
}
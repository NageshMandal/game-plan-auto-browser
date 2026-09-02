// ---------------------------------------------------------------------------
// src/scrape/pipeline.js — the per-store daily scrape, ported to puppeteer.
//
// This is the port of desklog_pipeline.js. Same phases, same endpoints, same
// report/drilldown parsing (via the injected desklog_extractor.js). Differences:
//   • report URLs are built on CRM_HOST (crm.connectcdk.com) instead of the old
//     www.eleadcrm.com — the brief gives the exact new customReport.aspx URLs.
//   • worker "tabs" are puppeteer pages opened in the same browser/context, so
//     they share the CRM session cookies with the main page (no re-login).
//   • the Lead Source report is reached by direct URL where possible. The
//     extension had to click through the left nav because id=1829 needed session
//     context; we keep that click-through as the primary path and fall back to
//     the direct id=1829 report URL.
//
// One ApiClient (this store's account) is threaded through every call.
// ---------------------------------------------------------------------------
import {
  REPORTS_URL,
  ELEAD_INDEX_URL,
  ELEAD_TRACK_ROOT,
  DRILLDOWN_PAGE_TIMEOUT,
  LEAD_TIMEOUT_MS,
  PHASE_WORKERS,
  RECHECK_TABS,
  LEADSOURCE_COLUMNS,
} from "../config.js";
import {
  sleep,
  safeNavigate,
  waitForLoad,
  ensureAssets,
  ensureAssetsAllFrames,
  evaluateInAllFrames,
  evaluateInMainFrame,
  rehostUrl,
  armPage,
} from "./inject.js";
import { scrapeLeadAllPages } from "./leadScraper.js";

// ── date helpers (extension parity) ──
function priorBusinessDay(today) {
  today = today || new Date();
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  d.setDate(d.getDate() - 1);
  if (d.getDay() === 0) d.setDate(d.getDate() - 1);
  return d;
}
const formatEleadDate = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const formatMMDDYYYY = (d) =>
  `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
const formatIsoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthStart = (today) => new Date((today || new Date()).getFullYear(), (today || new Date()).getMonth(), 1);

function filterLeadSourceDrilldowns(drilldowns) {
  if (!LEADSOURCE_COLUMNS) return drilldowns;
  const keep = new Set(LEADSOURCE_COLUMNS.map((s) => s.toLowerCase()));
  return drilldowns.filter((d) => keep.has(String(d.header || "").toLowerCase()));
}

// ── cross-frame click helpers (from desklog_pipeline) ──
async function clickFirstMatch(page, selectors) {
  const frames = await evaluateInAllFrames(page, (sels) => {
    for (const sel of sels) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { continue; }
      if (el) {
        try { el.click(); }
        catch (e) { try { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); } catch (_) {} }
        return { clicked: true };
      }
    }
    return { clicked: false };
  }, [selectors]);
  return (frames || []).some((f) => f.result && f.result.clicked);
}
async function waitForElementInAnyFrame(page, selector, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const frames = await evaluateInAllFrames(page, (sel) => {
      try { return !!document.querySelector(sel); } catch (e) { return false; }
    }, [selector]);
    if ((frames || []).some((f) => f.result)) return true;
    await sleep(800);
  }
  return false;
}

// ── Report A: Lead Source Stats (id=1829). Click-through, then extract. ──
async function runLeadSourceReport(page, targetDate, api, isoDate, log) {
  log("📊 Report A: Lead Source Stats");
  await safeNavigate(page, ELEAD_INDEX_URL);
  await waitForLoad(page, DRILLDOWN_PAGE_TIMEOUT);
  await sleep(2000);

  await evaluateInAllFrames(page, () => {
    const h = document.getElementById("tr95");
    if (h && h.getAttribute("aria-expanded") !== "true") { try { h.click(); } catch (e) {} }
  });
  await sleep(1000);

  const clickedIA = await clickFirstMatch(page, [
    "#MenuSections_MenuSectionItems_11_MenuSectionLink_7",
    'a[onclick*="InternetActivity-Rec"]',
    'a[title="Internet Activity - Rec"]',
  ]);
  if (!clickedIA) throw new Error('Could not find the "Internet Activity..." menu link');
  const sawMenu = await waitForElementInAnyFrame(page, 'a[href*="customreport.aspx?id=1829"], a[href*="customReport.aspx?id=1829"]', 25000);
  if (!sawMenu) throw new Error("Internet Activity menu did not load");
  await sleep(800);

  const clickedLSS = await clickFirstMatch(page, [
    'a[href*="customreport.aspx?id=1829"]', 'a[href*="customReport.aspx?id=1829"]',
  ]);
  if (!clickedLSS) throw new Error('Could not click "Lead Summary Stats"');
  const sawCriteria = await waitForElementInAnyFrame(page, "#btnRunReport", 25000);
  if (!sawCriteria) throw new Error("Lead Summary Stats criteria page did not load");
  await sleep(1000);

  const fromStr = formatMMDDYYYY(targetDate);
  const hiddenFrom = formatEleadDate(targetDate) + " 12:00:00 AM";
  const hiddenTo = formatEleadDate(targetDate) + " 11:59:59 PM";
  await evaluateInAllFrames(page, (fromV, toV, hFrom, hTo) => {
    const startInput = document.querySelector('input[name="start-date-input-simple"], input[id$="start-date-input"]');
    const endInput = document.querySelector('input[name="end-date-input-simple"], input[id$="end-date-input"]');
    const hStart = document.getElementById("datePickerStartDate");
    const hEnd = document.getElementById("datePickerEndDate");
    if (!document.getElementById("btnRunReport")) return { found: false };
    function setReact(input, val) {
      if (!input) return;
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      desc.set.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }
    setReact(startInput, fromV); setReact(endInput, toV);
    if (hStart) hStart.value = hFrom; if (hEnd) hEnd.value = hTo;
    return { found: true };
  }, [fromStr, fromStr, hiddenFrom, hiddenTo]);
  await sleep(800);

  const clickedGo = await clickFirstMatch(page, ["#btnRunReport", 'input[name="btnRunReport"]']);
  if (!clickedGo) throw new Error("Could not click GO");
  const sawReport = await waitForElementInAnyFrame(page, "#gvReport", DRILLDOWN_PAGE_TIMEOUT);
  if (!sawReport) throw new Error("Lead Source report table never rendered");
  await sleep(1500);

  await ensureAssetsAllFrames(page);
  const frameResults = await evaluateInAllFrames(page, () =>
    (window.__gp && window.__gp.extractLeadSourceStats) ? window.__gp.extractLeadSourceStats() : { error: "no_extractor" });
  const stats = (frameResults || []).map((f) => f.result).find((r) => r && !r.error && Array.isArray(r.headers) && r.headers.length);
  if (!stats) throw new Error("Lead-source extraction failed");

  try {
    await api.processDailyActivity({
      source: "leadsource-scrape", report: "lead-source-stats",
      report_url: stats.pageUrl || "", report_name: stats.reportName,
      dealership: stats.dealership, generated_at: stats.generatedAt,
      period_start: stats.period?.start || "", period_end: stats.period?.end || "",
      headers: stats.headers, rows: stats.rows, total: stats.total,
    });
  } catch (err) { log(`  ⚠ dailyactivities save failed: ${err.message}`); }

  return stats;
}

// ── Showroom-Up report (id=251 summary → id=1987 drilldowns) ──
async function runShowroomReport(page, targetDate, api, isoDate, log) {
  log("🏟️  Showroom-Up report");
  const ds = formatEleadDate(targetDate);
  const reportUrl = `${REPORTS_URL}?ID=251&run=yes&Department=&VehicleType=n&startdate=${encodeURIComponent(ds)}&enddate=${encodeURIComponent(ds)}`;
  const drillQs = `&Department=&User=-99&startdate=${encodeURIComponent(ds)}&enddate=${encodeURIComponent(ds)}&eleadDarkmode=false`;
  const buildDrill = (col) => ({
    column: col === "Visits" ? "Visits" : "Sold",
    header: col === "Visits" ? "Total Visits" : "Sold",
    url: `${REPORTS_URL}?id=1987&run=yes&Column=${col}${drillQs}`, value: "?",
  });

  let visitsDrilldown = null, soldDrilldown = null;
  try {
    await safeNavigate(page, reportUrl);
    if (!(await waitForLoad(page, DRILLDOWN_PAGE_TIMEOUT))) throw new Error("report did not load");
    await sleep(1500);
    if (!(await waitForElementInAnyFrame(page, "#gvReport", DRILLDOWN_PAGE_TIMEOUT))) throw new Error("#gvReport never rendered");
    await sleep(1000);
    await ensureAssetsAllFrames(page);
    const frameResults = await evaluateInAllFrames(page, () =>
      (window.__gp && window.__gp.extractDesklogStats) ? window.__gp.extractDesklogStats() : { error: "no_extractor" });
    const stats = (frameResults || []).map((f) => f.result).find((r) => r && !r.error && Array.isArray(r.reps) && r.reps.length);
    if (stats) {
      try {
        await api.saveShowroomReport({
          report: "showroom-up", report_url: stats.pageUrl || reportUrl,
          report_name: stats.reportName || "Desklog Statistics w/ Bebacks",
          dealership: stats.dealership, generated_at: stats.generatedAt, department: stats.department,
          period_start: stats.period?.start || ds, period_end: stats.period?.end || ds,
          headers: stats.headers, reps: stats.reps, total: stats.total,
        });
      } catch (err) { log(`  ⚠ showroom-up-report save failed: ${err.message}`); }
      const dds = stats.totalDrilldownUrls || [];
      const findCol = (name) => dds.find((d) => String(d.column || "").toLowerCase() === name);
      visitsDrilldown = findCol("visits") || null;
      soldDrilldown = findCol("sold") || null;
    }
  } catch (err) {
    log(`  ⚠ Showroom summary failed: ${err.message} — using direct drilldowns`);
  }
  if (!visitsDrilldown) visitsDrilldown = buildDrill("Visits");
  if (!soldDrilldown) soldDrilldown = buildDrill("Sold");
  return { visitsDrilldown, soldDrilldown };
}

// ── Walk drilldown pages → collect + save lead URLs ──
async function discoverLeadUrls(page, drilldownUrls, api, isoDate, label, log) {
  const allLeads = new Map();
  for (let i = 0; i < drilldownUrls.length; i++) {
    const dd = drilldownUrls[i];
    const col = dd.column || dd.header || `col${i}`;
    try {
      await safeNavigate(page, rehostUrl(dd.url));
      if (!(await waitForLoad(page, DRILLDOWN_PAGE_TIMEOUT))) continue;
      await sleep(1000);
      await ensureAssets(page);
      const res = await evaluateInMainFrame(page, () =>
        (window.__gp && window.__gp.extractDrilldownLeadUrls) ? window.__gp.extractDrilldownLeadUrls() : { leads: [] });
      const leads = (res && res.leads) || [];
      for (const l of leads) if (!allLeads.has(l.dealId)) allLeads.set(l.dealId, { ...l, source_column: col });
      if (leads.length) {
        try {
          await api.saveDailyUrls({
            date: isoDate, source_column: col,
            leads: leads.map((l) => ({ personId: l.personId, dealId: l.dealId, name: l.name, url: rehostUrl(l.url), source_column: col })),
          });
        } catch (err) { log(`    ⚠ save-daily-urls failed: ${err.message}`); }
      }
    } catch (err) { log(`    ❌ ${col} error: ${err.message}`); }
  }
  log(`  ✓ ${label}: ${allLeads.size} unique lead(s)`);
  return Array.from(allLeads.values());
}

// ── Store-visit capture (Visits − Sold) ──
async function captureStoreVisits(page, visitsDrilldown, soldDrilldown, api, isoDate, log) {
  async function readDrilldown(dd) {
    if (!dd || !dd.url) return [];
    try {
      await safeNavigate(page, rehostUrl(dd.url));
      if (!(await waitForLoad(page, DRILLDOWN_PAGE_TIMEOUT))) return [];
      await sleep(1000);
      await ensureAssets(page);
      const res = await evaluateInMainFrame(page, () =>
        (window.__gp && window.__gp.extractDrilldownLeadUrls) ? window.__gp.extractDrilldownLeadUrls() : { leads: [] });
      return (res && res.leads) || [];
    } catch { return []; }
  }
  try {
    const visitLeads = await readDrilldown(visitsDrilldown);
    const soldLeads = await readDrilldown(soldDrilldown);
    const soldPersons = new Set(soldLeads.map((l) => String(l.personId || "")).filter(Boolean));
    const soldDeals = new Set(soldLeads.map((l) => String(l.dealId || "")).filter(Boolean));
    const seen = new Set(); const notSold = [];
    for (const v of visitLeads) {
      const cppid = String(v.personId || "").trim();
      if (!cppid || soldPersons.has(cppid)) continue;
      if (v.dealId && soldDeals.has(String(v.dealId))) continue;
      if (seen.has(cppid)) continue;
      seen.add(cppid);
      notSold.push({ cppid, leadurl: rehostUrl(v.url || ""), deal_id: v.dealId || "", name: v.name || "" });
    }
    try { await api.saveStoreVisits({ date: isoDate, visits: notSold }); }
    catch (err) { log(`  ⚠ save-store-visits failed: ${err.message}`); }
  } catch (err) { log(`  ⚠ store-visit capture failed: ${err.message}`); }
}

// ── Sold reconciliation (month-to-date) ──
async function runSoldReconciliation(page, config, api, isoDate, log) {
  const today = new Date();
  let startDate = config.reconStartDate && /^\d{4}-\d{2}-\d{2}$/.test(config.reconStartDate)
    ? new Date(...config.reconStartDate.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))
    : monthStart(today);
  const dsStart = formatEleadDate(startDate), dsEnd = formatEleadDate(today), sinceIso = formatIsoDate(startDate);
  const soldUrl = `${REPORTS_URL}?id=1987&run=yes&Column=Sold&Department=&User=-99&startdate=${encodeURIComponent(dsStart)}&enddate=${encodeURIComponent(dsEnd)}&eleadDarkmode=false`;

  let soldRows = [];
  try {
    await safeNavigate(page, soldUrl);
    if (!(await waitForLoad(page, DRILLDOWN_PAGE_TIMEOUT))) throw new Error("Sold drilldown did not load");
    await sleep(1200);
    await ensureAssets(page);
    const res = await evaluateInMainFrame(page, () =>
      (window.__gp && window.__gp.extractDrilldownLeadUrls) ? window.__gp.extractDrilldownLeadUrls() : { leads: [] });
    soldRows = (res && res.leads) || [];
  } catch (err) { log(`  ⚠ sold recon read failed: ${err.message}`); return { queued: 0, queuedDealIds: [] }; }
  if (!soldRows.length) return { queued: 0, queuedDealIds: [] };

  const byDeal = new Map(); const seenDms = new Set();
  for (const r of soldRows) {
    if (!r.dealId) continue;
    if (r.isCoBuyer) continue;
    if (r.dmsId && seenDms.has(r.dmsId)) continue;
    if (byDeal.has(r.dealId)) continue;
    if (r.dmsId) seenDms.add(r.dmsId);
    byDeal.set(r.dealId, r);
  }

  let scored = new Set();
  try { const s = await api.soldScoredIds(sinceIso); scored = new Set((s.dealIds || []).map(String)); } catch {}
  const missing = [];
  for (const [dealId, row] of byDeal) if (!scored.has(String(dealId))) missing.push(row);
  if (!missing.length) return { queued: 0, queuedDealIds: [] };

  let queued = 0;
  try {
    const saved = await api.saveDailyUrls({
      date: isoDate, source_column: "SoldRecon",
      leads: missing.map((l) => ({ personId: l.personId, dealId: l.dealId, name: l.name, url: rehostUrl(l.url), source_column: "SoldRecon" })),
    });
    if (saved && typeof saved.inserted === "number") queued = saved.inserted;
  } catch (err) { log(`  ⚠ queue missing sold failed: ${err.message}`); }
  log(`🧮 Sold recon: queued ${queued} missing (of ${byDeal.size})`);
  return { queued, queuedDealIds: missing.map((l) => String(l.dealId)) };
}

// ── Phase 2: scrape pending daily_urls across N worker pages ──
async function runLeadScrape(context, api, isoDate, fallbackLeads, state, log) {
  let pending = [];
  try { const resp = await api.dailyUrlsPending(isoDate); pending = resp.leads || []; }
  catch { pending = fallbackLeads || []; }
  if (!pending.length) { log("  Nothing to scrape"); return; }

  state.total = pending.length;
  const queue = [...pending];

  const runWorker = async (idx) => {
    let page;
    // Stagger worker startup. Each new tab opens its own proxy tunnel and its
    // own SAML handshake; firing all of them at once trips connection-capped
    // proxies (ERR_TUNNEL_CONNECTION_FAILED). 1.5s apart is enough to spread it.
    if (idx > 0) await sleep(idx * 1500);
    try { page = await context.newPage(); await armPage(page, log); }
    catch (err) { log(`  W${idx}: page create failed — ${err.message}`); return; }
    try {
      await safeNavigate(page, ELEAD_TRACK_ROOT);
      await waitForLoad(page, 15000);
      while (queue.length && state.running) {
        const lead = queue.shift();
        if (!lead) break;
        state.scraped++;
        try {
          const scrapeOne = (async () => {
            await safeNavigate(page, rehostUrl(lead.url));
            await sleep(3000);
            await waitForLoad(page, 25000);
            await sleep(2000);
            return scrapeLeadAllPages(page, lead, { delay: 3000 }, "full", {}, () => {});
          })();
          const { mainData, subPages, allUrls } = await withTimeout(scrapeOne, LEAD_TIMEOUT_MS, { mainData: null, subPages: [], allUrls: [] });
          if (!mainData) { state.failed++; log(`  W${idx}: ❌ ${lead.name} (no data)`); continue; }
          const saved = await api.sendLead(lead, { mainData, subPages, allUrls }, "daily-scrape");
          if (saved) { state.saved++; log(`  W${idx}: ✅ ${lead.name}`); }
          else { state.failed++; log(`  W${idx}: ❌ save failed ${lead.name}`); }
        } catch (err) { state.failed++; log(`  W${idx}: ❌ ${lead.name} — ${err.message}`); }
      }
    } finally {
      try { await page.close(); } catch {}
    }
  };

  const workers = [];
  for (let i = 0; i < PHASE_WORKERS; i++) workers.push(runWorker(i));
  await Promise.all(workers);
  log(`  ✓ Lead scrape: ${state.saved} saved, ${state.failed} failed`);
}

// ── Rechecks (parallel worker pages) ──
async function runRechecks(context, mainPage, api, isoDate, skipDealIds, state, log) {
  let items = [];
  try { items = await api.pendingRechecks(500); } catch {}
  const rechecks = (items || []).map((item) => ({
    personId: "", dealId: item.deal_id, name: item.customer_name || item.deal_id || "Recheck",
    url: rehostUrl(item.lead_url || `https://www.eleadcrm.com/evo2/fresh/elead-v45/elead_track/NewProspects/OpptyDetails.aspx?lDID=${item.deal_id}&loc=DeskLogDLL&R=NO&LICID=`),
  }));
  if (!rechecks.length) { log("🔁 No recheck leads"); return { saved: 0 }; }

  const skip = new Set((skipDealIds || []).map(String));
  const conc = Math.max(1, Math.min(RECHECK_TABS, rechecks.length));
  let saved = 0, failed = 0, nextIndex = 0;

  const worker = async (wi) => {
    let page;
    if (wi === 0) page = mainPage;
    else {
      // Same staggering as the lead scrape — avoid a burst of tunnels/SAML.
      await sleep(wi * 1500);
      try { page = await context.newPage(); await armPage(page, log); await safeNavigate(page, ELEAD_TRACK_ROOT); await waitForLoad(page, 15000); }
      catch { return; }
    }
    try {
      while (state.running) {
        const i = nextIndex++;
        if (i >= rechecks.length) break;
        const lead = rechecks[i];
        if (lead.dealId && skip.has(String(lead.dealId))) continue;
        try {
          const doRecheck = (async () => {
            await safeNavigate(page, rehostUrl(lead.url));
            await sleep(3000);
            await waitForLoad(page, 20000);
            await sleep(2000);
            const pid = (lead.url || "").match(/lPID=(\d+)/);
            const personId = lead.personId || (pid ? pid[1] : "");
            let opts = { wantQuote: true, wantSold: true };
            try {
              const pages = await api.leadPages(personId, lead.dealId);
              if (pages && pages.found) opts = { wantQuote: !pages.hasQuote, wantSold: !pages.hasSold };
            } catch {}
            return scrapeLeadAllPages(page, lead, { delay: 3000 }, "recheck", opts, () => {});
          })();
          const { mainData, subPages, allUrls } = await withTimeout(doRecheck, LEAD_TIMEOUT_MS, { mainData: null, subPages: [], allUrls: [] });
          if (!mainData) { failed++; continue; }
          if (String(mainData.dealId || "") && String(lead.dealId || "") && String(mainData.dealId) !== String(lead.dealId)) { failed++; continue; }
          const ok = await api.sendLead(lead, { mainData, subPages, allUrls }, "recheck");
          if (ok) saved++; else failed++;
        } catch { failed++; }
      }
    } finally {
      if (wi !== 0) { try { await page.close(); } catch {} }
    }
  };

  const workers = [];
  for (let w = 0; w < conc; w++) workers.push(worker(w));
  await Promise.all(workers);
  log(`🔁 Rechecks done — saved ${saved}, failed ${failed}`);
  return { saved, failed };
}

// promise watchdog (extension parity)
function withTimeout(promise, ms, fallback) {
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([
    Promise.resolve(promise).then((v) => { clearTimeout(timer); return v; }, () => { clearTimeout(timer); return fallback; }),
    guard,
  ]);
}

// Total wall-clock the pipeline may use before it must wrap up, and how much of
// that to hold back for markScrapeDone. Defaults sit safely inside the
// launcher's `timeout 40m`.
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS) || 32 * 60 * 1000;
const FINALIZE_RESERVE_MS = Number(process.env.FINALIZE_RESERVE_MS) || 3 * 60 * 1000;

/**
 * Run the full daily pipeline for one store, on an already-in-CRM `page`.
 *   @param page      main puppeteer page, sitting inside the eLead CRM
 *   @param context   its browser context (for spawning worker pages)
 *   @param api       this store's ApiClient
 *   @param config    { targetDate?, reconStartDate?, skipSoldRecon? }
 *   @param log       logger
 */
export async function runStorePipeline(page, context, api, config = {}, log = () => {}) {
  const runStartedAt = Date.now();
  const state = { total: 0, scraped: 0, saved: 0, failed: 0, running: true };
  const targetDate = config.targetDate
    ? new Date(config.targetDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1/$2/$3"))
    : priorBusinessDay();
  const isoDate = formatIsoDate(targetDate);
  log(`📅 Target date ${isoDate}`);

  // Clear daily_urls, then discover from both reports.
  try { await api.clearDailyUrls(); } catch (err) { log(`  ⚠ clear daily-urls: ${err.message}`); }

  // Both reports run SEQUENTIALLY on the one CRM tab. They used to run on two
  // tabs in parallel, but every extra tab opens its own proxy tunnel AND its
  // own Okta SAML handshake — which is what produced ERR_TUNNEL_CONNECTION_
  // FAILED against connection-capped proxies. Sequential is slightly slower but
  // reliable, and the heavy work (the lead scrape) is still parallel below.
  let lsLeads = [];
  try {
    const stats = await runLeadSourceReport(page, targetDate, api, isoDate, log);
    const drills = filterLeadSourceDrilldowns(stats.totalDrilldownUrls || []);
    lsLeads = await discoverLeadUrls(page, drills, api, isoDate, "A (lead source)", log);
  } catch (err) {
    log(`❌ Report A failed: ${err.message}`);
  }

  try {
    const showroom = await runShowroomReport(page, targetDate, api, isoDate, log);
    const drills = [];
    if (showroom.soldDrilldown) drills.push({ ...showroom.soldDrilldown, column: "ShowroomSold" });
    if (showroom.visitsDrilldown) drills.push({ ...showroom.visitsDrilldown, column: "ShowroomVisits" });
    if (drills.length) {
      const shLeads = await discoverLeadUrls(page, drills, api, isoDate, "Showroom", log);
      const seen = new Set(lsLeads.map((l) => String(l.dealId)));
      for (const l of shLeads) if (!seen.has(String(l.dealId))) lsLeads.push(l);
    }
    try { await captureStoreVisits(page, showroom.visitsDrilldown, showroom.soldDrilldown, api, isoDate, log); } catch {}
  } catch (err) {
    log(`❌ Showroom report failed: ${err.message}`);
  }

  // Sold reconciliation on the main page.
  let recon = { queued: 0, queuedDealIds: [] };
  if (!config.skipSoldRecon) {
    try { recon = await runSoldReconciliation(page, config, api, isoDate, log); }
    catch (err) { log(`🧮 sold recon failed: ${err.message}`); }
  }

  // Phase 2: scrape pending.
  await runLeadScrape(context, api, isoDate, lsLeads, state, log);

  // Rechecks — bounded by the remaining run budget.
  //
  // The agent is launched under `timeout 40m` with a 45-minute dead-man switch.
  // If rechecks overrun that, the process is killed mid-phase and
  // markScrapeDone below NEVER RUNS — so no schedule run is created and the
  // night's work is never handed to the agent, even though the leads were
  // saved. A handful of un-loadable leads is enough to cause it.
  //
  // So rechecks get whatever is left of RUN_BUDGET_MS minus a reserve for
  // mark-done. Overrunning now means "stop rechecking and finish cleanly"
  // rather than "die and lose the run".
  let recheck = { saved: 0 };
  const elapsed = Date.now() - runStartedAt;
  const recheckBudget = Math.max(60000, RUN_BUDGET_MS - elapsed - FINALIZE_RESERVE_MS);
  log(`🔁 Recheck budget: ${Math.round(recheckBudget / 60000)} min`);
  try {
    recheck = await withTimeout(
      runRechecks(context, page, api, isoDate, recon.queuedDealIds, state, log),
      recheckBudget,
      null,
    );
    if (recheck === null) {
      log("🔁 Recheck budget exhausted — finishing so the agent still gets scheduled");
      recheck = { saved: 0 };
    }
  } catch (err) { log(`🔁 recheck failed: ${err.message}`); recheck = { saved: 0 }; }

  // Arm the agent (schedule run) if anything saved.
  if (state.saved > 0 || recheck.saved > 0) {
    try {
      const r = await api.markScrapeDone();
      if (r.success) log("🤖 Scrape marked done — agent scheduled");
      else log(`🤖 mark-done failed: ${r.error}`);
    } catch (err) { log(`🤖 mark-done error: ${err.message}`); }
  } else {
    log("Nothing saved — agent not scheduled");
  }

  log(`🏁 Store done. Leads ${state.saved} | recon queued ${recon.queued} | rechecks ${recheck.saved} | failed ${state.failed}`);
  return { ...state, reconQueued: recon.queued, recheckSaved: recheck.saved };
}
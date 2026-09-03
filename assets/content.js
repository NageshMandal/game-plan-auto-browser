// content.js - eLead CRM DOM Scraper v4
// Scrapes main page + discovers all sub-page URLs + scrapes any sub-page generically

// ═══════════════════════════════════════════════════════════════
// IDEMPOTENT INJECTION GUARD
// ───────────────────────────────────────────────────────────────
// Chrome can inject this script multiple times into the same page:
//   1. Manifest-registered content_scripts at document_idle
//   2. chrome.scripting.executeScript() calls from background.js
//   3. SPA-style in-page navigations that re-fire injection
// Each re-injection re-runs the WHOLE file, which means every top-
// level const/let/class (TAB_LABEL_MAP, etc.) re-declares and throws
// "Identifier 'X' has already been declared".
//
// Guard pattern: stash a flag on window. If we're already loaded,
// bail before executing anything. Use a window-property assignment
// (NOT const/let) so the check itself can never throw on re-run.
// ═══════════════════════════════════════════════════════════════
if (window.__gpScraperLoaded__) {
  console.log('[eLead Scraper] content.js already loaded — skipping re-injection');
} else {
  window.__gpScraperLoaded__ = true;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SCRAPE_LEAD_PAGE') {
    try { sendResponse({ success: true, data: scrapeMainPage() }); }
    catch (err) { sendResponse({ success: false, error: err.message }); }
    return true;
  }
  if (msg.type === 'FIND_SUB_URLS') {
    try { sendResponse({ success: true, urls: findAllSubPageUrls() }); }
    catch (err) { sendResponse({ success: false, error: err.message, urls: [] }); }
    return true;
  }
  if (msg.type === 'SCRAPE_SUB_PAGE') {
    try { sendResponse({ success: true, data: scrapeAnyPage() }); }
    catch (err) { sendResponse({ success: false, error: err.message }); }
    return true;
  }
  if (msg.type === 'SCRAPE_CALLDRIP') {
    try { sendResponse({ success: true, data: scrapeCallDripData() }); }
    catch (err) { sendResponse({ success: false, error: err.message, data: { urls: [], activities: [] } }); }
    return true;
  }
  if (msg.type === 'RESOLVE_CALLDRIP_TYPES') {
    // background.js runs its own all-frames CallDrip sweep and can only
    // return plain data from an injected function — it cannot call the
    // matching helpers here. So it hands back {url, agentName} pairs and
    // we resolve them against THIS page's Sales Teams panel, keeping one
    // implementation of the name matching instead of two.
    try {
      const index = buildRepIndex(getSalesReps(getSalesTeam()), 0)
        .concat(buildRepIndex(msg.extraReps || [], 1));
      const out = (msg.entries || []).map(e => {
        const who = resolveRepType(e && e.agentName, index);
        return {
          url: (e && e.url) || '',
          callId: callDripIdFromUrl(e && e.url),
          type: who.type, repType: who.repType, agentName: who.agentName,
          matchedRepName: who.matchedRepName, role: who.role,
          typeSource: who.typeSource,
        };
      });
      sendResponse({ success: true, entries: out });
    } catch (err) { sendResponse({ success: false, error: err.message, entries: [] }); }
    return true;
  }
  if (msg.type === 'GET_PAGE_DIMENSIONS') {
    sendResponse({ scrollHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), clientHeight: document.documentElement.clientHeight });
    return true;
  }
  if (msg.type === 'SCROLL_TO') { window.scrollTo(0, msg.y); sendResponse({ done: true }); return true; }
  if (msg.type === 'SCROLL_TOP') { window.scrollTo(0, 0); sendResponse({ done: true }); return true; }
  if (msg.type === 'COLLECT_LEAD_LINKS') {
    try { sendResponse({ success: true, leads: collectLeadLinksFromPage() }); }
    catch (err) { sendResponse({ success: false, error: err.message, leads: [] }); }
    return true;
  }
  if (msg.type === 'LIST_TABS') {
    try { sendResponse({ success: true, tabs: listLeadPageTabs() }); }
    catch (err) { sendResponse({ success: false, error: err.message, tabs: [] }); }
    return true;
  }
  if (msg.type === 'CLICK_TAB') {
    try { sendResponse({ success: clickLeadPageTab(msg.tabLiId) }); }
    catch (err) { sendResponse({ success: false, error: err.message }); }
    return true;
  }
  if (msg.type === 'SCRAPE_TAB_IFRAME') {
    try { sendResponse({ success: true, data: scrapeTabIframe() }); }
    catch (err) { sendResponse({ success: false, error: err.message }); }
    return true;
  }
  if (msg.type === 'SCRAPE_TEXT_MESSAGES') {
    try { sendResponse({ success: true, data: scrapeTextMessagesPage() }); }
    catch (err) { sendResponse({ success: false, error: err.message }); }
    return true;
  }
  if (msg.type === 'GP_TRIGGER_CALL') {
    // Sidepanel sent a direct click-to-call from a re-focused tab.
    try { _gpTryClickToCall(); sendResponse({ ok: true }); }
    catch (err) { sendResponse({ ok: false, error: err.message }); }
    return false;
  }
  if (msg.type === 'AUTO_CLICK_ACTION') {
    // Triggered from background.js after the side panel's Call / Text
    // button opens this lead page. We poll the DOM for the matching
    // menubar action and click it. Only one frame on the page will
    // actually find the element — the rest no-op.
    autoClickMenubarAction(msg.action)
      .then(clicked => sendResponse({ success: clicked }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }
});

// ════════════════════════════════════════════════════════════════
// CRM ORIGIN
// ────────────────────────────────────────────────────────────────
// This file was written against www.eleadcrm.com and hard-coded that host
// everywhere it builds an absolute URL or asks "is this link internal?".
// The CRM has since moved to crm.connectcdk.com, which broke BOTH uses:
//
//   • findAllSubPageUrls().addUrl() gated on the URL containing
//     "eleadcrm.com", so every sub-page link discovered from the LIVE DOM
//     was silently rejected — Sold History found via <a href> was lost.
//   • The activity sweep filtered externals with
//     !href.includes("eleadcrm.com"), so internal eLead links now read as
//     EXTERNAL and can land in externalUrls[0], which feeds callDripUrl.
//
// Both are fixed by asking the page instead of assuming. This script runs
// inside the CRM, so location.origin IS the answer. window.__gpCrmOrigin
// (set by src/scrape/inject.js from config) takes precedence for the
// puppeteer runner; the legacy constant survives only as a last resort and
// rehostUrl() repairs it at the seam.
// ════════════════════════════════════════════════════════════════

var GP_ELEAD_HOST_RE = /(?:^|\.)(?:eleadcrm\.com|connectcdk\.com)$/i;

// TRUE when a URL points at the CRM itself (any of its hosts, past or
// present) rather than a third party like calldrip.com or truecar.com.
// Relative URLs resolve against the current page, so they count as internal.
function gpIsCrmUrl(u) {
  var s = String(u || '').trim();
  if (!s || /^(javascript|mailto|tel):/i.test(s)) return false;
  try {
    return GP_ELEAD_HOST_RE.test(new URL(s, location.href).hostname);
  } catch (e) {
    return false;
  }
}

// The origin to build absolute CRM URLs against.
function gpCrmOrigin() {
  try {
    if (window.__gpCrmOrigin) {
      return String(window.__gpCrmOrigin).replace(/\/+$/, '');
    }
  } catch (e) {}
  try {
    if (location && location.origin && GP_ELEAD_HOST_RE.test(location.hostname)) {
      return location.origin;
    }
  } catch (e) {}
  return 'https://www.eleadcrm.com';   // last resort; rehostUrl() fixes it
}

// Pick the best display name for a lead from the anchor we matched. A grid row
// often links the SAME lead from its date, name and vehicle cells; whichever
// anchor the DOM yielded first used to win, and its text became the name — so
// leads were being labelled "9/02/26".
//
// The discriminator is digits. A person's name effectively never contains
// them; a date ("9/02/26"), a vehicle ("2026 Jeep Grand Wagoneer"), a stock
// number and a dollar amount all do. So: take the anchor's own text when it
// qualifies, otherwise scan its row for the longest digit-free candidate.
function gpLooksLikeName(t) {
  var s = String(t || '').trim();
  if (s.length < 2 || s.length > 80) return false;
  if (/\d/.test(s)) return false;              // dates, vehicles, money, stock #s
  if (!/[A-Za-z]{2}/.test(s)) return false;    // needs real letters
  // eLead status / flag words that sit in their own cells
  return !/^(?:N|U|Y|New|Sold|Active|Inactive|Open|Closed|Quote|Delivered|Unknown)$/i.test(s);
}

function gpBestLeadName(el) {
  function clean(t) {
    return String(t || '').trim().replace(/\s+/g, ' ').substring(0, 80);
  }
  var own = clean(el && el.textContent);
  if (gpLooksLikeName(own)) return own;

  var row = el && el.closest ? el.closest('tr') : null;
  if (!row) return own;
  var best = '';
  var cells = row.querySelectorAll('td');
  for (var i = 0; i < cells.length; i++) {
    var t = clean(cells[i].textContent);
    if (gpLooksLikeName(t) && t.length > best.length) best = t;
  }
  return best || own;
}

// The canonical lead-detail URL for a person/deal pair. One definition, so
// the shape can never drift between the three places that used to inline it.
function gpOpptyUrl(personId, dealId) {
  return gpCrmOrigin() +
    '/evo2/fresh/elead-v45/elead_track/NewProspects/OpptyDetails.aspx' +
    '?lPID=' + encodeURIComponent(personId || '') +
    '&lDID=' + encodeURIComponent(dealId || '') +
    '&loc=DeskLogDLL&R=NO&LICID=';
}

// ════════════════════════════════════════════════════════════════
// HISTORY SCOPE  —  scrape the CURRENT deal, not the customer's life
// ────────────────────────────────────────────────────────────────
// eLead's Contacts tab prints EVERY completed activity this person has
// ever generated, back to the day the record was created (2015 on some
// of these files). Scraping all of it means callDripUrls picks up calls
// from deals that closed years ago, the CallDrip fetcher pulls every
// transcript, and downstream rep-assignment treats a stale voicemail as
// evidence about who is working TODAY's lead.
//
// The page is already structured by opportunity, so we scope by
// STRUCTURE first and use dates only as a secondary gate:
//
//   <tr class="PageHeaderContacts">          ← one per opportunity
//       <td onclick="swapDiv('104642834')">  ← the opportunity id
//       <td>9/02/26 1:23 PM</td>             ← its last-activity date
//   <tr><td id="div_104642834">  …all of that opportunity's rows…
//
// RULES
//   1. CURRENT DEAL — the block whose id === g_data.OpportunityId is
//      ALWAYS scraped in full, however old its rows are. This is the
//      hard anchor: no date arithmetic, no "first row" guessing. A deal
//      worked for 18 months keeps its origination row and its test
//      drive. Falls back to the first block in document order only if
//      the id can't be read.
//   2. PRIOR DEALS — scraped only when the block's own header date is
//      within GP_PRIOR_OPP_DAYS (default 21). A prior opportunity that
//      was live 2-3 weeks ago is context; one that closed 8 months or
//      5 years ago is noise, and it is skipped whole — header row,
//      child table, CallDrip links and all.
//   3. UNGROUPED ROWS — "Other Activity History" (texts, opt-outs,
//      birthday/service email) belongs to no opportunity, so structure
//      can't scope it. Those rows use the date window, GP_HISTORY_DAYS
//      (default 90). This is what preserves a customer's STOP reply,
//      which is compliance-critical and never sits under a deal.
//   4. MEGA-ROWS — eLead renders each opportunity's child table twice:
//      as individual <tr>s and as one "mega row" whose first <td> is
//      the whole table flattened to text. The dupes are always dropped.
//
// Tunables come off window.*, set by the injector (src/scrape/inject.js)
// from src/config.js. Running as a plain extension content script, the
// defaults below apply.
// ════════════════════════════════════════════════════════════════

var GP_HISTORY_DAYS_DEFAULT = 90;      // ungrouped rows only
var GP_PRIOR_OPP_DAYS_DEFAULT = 21;    // prior opportunity blocks
var GP_MAX_CELL_CHARS_DEFAULT = 300;
var GP_MEGA_ROW_DATE_COUNT = 3;

function gpHistoryDays() {
  var v = Number(window.__gpHistoryDays);
  return (isFinite(v) && v > 0) ? v : GP_HISTORY_DAYS_DEFAULT;
}
function gpPriorOppDays() {
  var v = Number(window.__gpPriorOppDays);
  return (isFinite(v) && v >= 0) ? v : GP_PRIOR_OPP_DAYS_DEFAULT;
}
function gpMaxCellChars() {
  var v = Number(window.__gpMaxCellChars);
  return (isFinite(v) && v > 0) ? v : GP_MAX_CELL_CHARS_DEFAULT;
}
function gpCutoffMs() {
  return Date.now() - (gpHistoryDays() * 86400000);
}
function gpPriorOppCutoffMs() {
  return Date.now() - (gpPriorOppDays() * 86400000);
}

// eLead activity datetime, exactly as printed in the history tables:
//   "9/02/26 8:01 AM"  "12/29/25 2:26 PM"  "4/24/2015 6:00 AM"
// The Service tab uses a seconds variant ("4/7/2020 3:08:07 AM").
//
// NOTE ON ANCHORS: row.textContent concatenates cells with NO separator, so a
// row reads "keyboard_arrow_down6/25/25 1:02 PMOutbound Call01:15…". A \b
// anchor on either end therefore FAILS (letter-digit and letter-letter are not
// word boundaries), the date is never found, and the row is misread as "not an
// activity row" — which silently disables the whole window filter. Use a
// digit-lookbehind at the front and no anchor at the back.
var GP_ACTIVITY_DT_RE =
  /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP])M/i;
var GP_ACTIVITY_DT_RE_G = new RegExp(GP_ACTIVITY_DT_RE.source, 'gi');

// Parse one match array into epoch ms. 2-digit years are 2000s — eLead
// never shows a 19xx activity, and "26" must read as 2026, not 1926.
function gpMatchToMs(m) {
  if (!m) return null;
  var mo = parseInt(m[1], 10);
  var da = parseInt(m[2], 10);
  var yr = parseInt(m[3], 10);
  var hr = parseInt(m[4], 10);
  var mi = parseInt(m[5], 10);
  var ap = (m[6] || '').toUpperCase();
  if (!(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31)) return null;
  if (yr < 100) yr += 2000;
  if (yr < 1990 || yr > 2200) return null;
  if (ap === 'P' && hr < 12) hr += 12;
  if (ap === 'A' && hr === 12) hr = 0;
  var t = new Date(yr, mo - 1, da, hr, mi, 0, 0).getTime();
  return isNaN(t) ? null : t;
}

// Newest activity datetime in a blob of row text, or null when the row
// carries none (i.e. it isn't an activity row at all).
function gpNewestActivityMs(text) {
  var s = String(text || '');
  if (!s) return null;
  GP_ACTIVITY_DT_RE_G.lastIndex = 0;
  var best = null, m;
  while ((m = GP_ACTIVITY_DT_RE_G.exec(s)) !== null) {
    var t = gpMatchToMs(m);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

function gpCountActivityDates(text) {
  var s = String(text || '');
  if (!s) return 0;
  GP_ACTIVITY_DT_RE_G.lastIndex = 0;
  var n = 0;
  while (GP_ACTIVITY_DT_RE_G.exec(s) !== null) n++;
  return n;
}

// TRUE for eLead's flattened child-table dumps. These duplicate rows we
// already capture individually, and they are what makes a single lead
// doc balloon into hundreds of KB.
function gpIsMegaRow(cells, text) {
  var maxCell = gpMaxCellChars();
  var list = cells || [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i] == null ? '' : list[i]).length > maxCell) return true;
  }
  return gpCountActivityDates(text) >= GP_MEGA_ROW_DATE_COUNT;
}

// The single gate every history row passes through.
//   'keep'      → in-window activity row, or a non-activity row
//   'stale'     → activity row older than the window
//   'mega'      → flattened child-table dump
function gpRowVerdict(cells, text) {
  var t = text != null ? text : (cells || []).join(' ');
  if (gpIsMegaRow(cells, t)) return 'mega';
  var when = gpNewestActivityMs(t);
  if (when === null) return 'keep';           // not an activity row
  return when >= gpCutoffMs() ? 'keep' : 'stale';
}

function gpRowInWindow(cells, text) {
  return gpRowVerdict(cells, text) === 'keep';
}

// ── OPPORTUNITY BLOCKS ──────────────────────────────────────────
// The current deal id, straight off the lead page. g_data is the
// authority; the lDID query param is the fallback; window.__gpDealId
// lets the runner override when neither is reachable (e.g. the scan
// is running inside a frame that has no g_data of its own).
function gpCurrentDealId() {
  try {
    if (window.__gpDealId) return String(window.__gpDealId).trim();
  } catch (e) {}
  try {
    var g = extractGData() || {};
    var id = g.OpportunityId || g.opportunityId || '';
    if (id) return String(id).trim();
  } catch (e) {}
  try {
    var p = getUrlParam('lDID');
    if (p) return String(p).trim();
  } catch (e) {}
  return '';
}

// "104642834" from <i id="img_104642834"> or onclick="swapDiv('104642834')".
// Both are read because eLead has moved this handler between the <tr>, the
// first <td> and the <i> across releases — if one anchor disappears the
// other still resolves the block.
function gpOppIdFromHeaderRow(row) {
  if (!row || !row.querySelector) return '';
  var ic = row.querySelector('[id^="img_"]');
  if (ic && ic.id) {
    var m = String(ic.id).match(/^img_(\d+)$/);
    if (m) return m[1];
  }
  var nodes = [row].concat([].slice.call(row.querySelectorAll('[onclick]')));
  for (var i = 0; i < nodes.length; i++) {
    var oc = (nodes[i].getAttribute && nodes[i].getAttribute('onclick')) || '';
    var m2 = oc.match(/swapDiv\s*\(\s*['"]?(\d+)['"]?\s*\)/);
    if (m2) return m2[1];
  }
  return '';
}

// Which opportunity does an ordinary row live under? Rows inside an
// opportunity sit in <td id="div_<oppId>">; ungrouped rows return ''.
function gpOppIdForRow(row) {
  if (!row || !row.closest) return '';
  var box = row.closest('td[id^="div_"]');
  if (!box || !box.id) return '';
  var m = String(box.id).match(/^div_(\d+)$/);
  return m ? m[1] : '';
}

function gpIsOppHeaderRow(row) {
  return !!(row && row.classList && row.classList.contains('PageHeaderContacts'));
}

// eLead nests a tiny layout <table> inside the "Activity Type" cell to put the
// icon next to the label:
//     <td class="activityHeader"><table><tr><td>Outbound Call<br>00:31</td></tr></table></td>
// querySelectorAll('table tr') matches that inner <tr> too, so it surfaces as
// a phantom one-cell row ("Outbound Call00:31") carrying no date and no
// opportunity. It is a duplicate of text already in its parent row's cells,
// and because it has no date it survives every filter — including when its
// PARENT row was correctly dropped. Detect it by ancestry: a genuine row's
// nearest ancestor <td> is either nothing or the td#div_<oppId> opportunity
// container; anything else means we are inside a presentation sub-table.
function gpIsNestedLayoutRow(row) {
  if (!row || !row.parentElement || !row.parentElement.closest) return false;
  var td = row.parentElement.closest('td');
  if (!td) return false;
  return !/^div_\d+$/.test(td.id || '');
}

// Decide, once per document, which opportunity blocks to scrape.
// Returns null when the document has no opportunity blocks at all
// (Vehicles, Audit Trail, Lifetime Value … ) so those tabs are
// completely unaffected by this logic.
var _gpPlanCache = (typeof WeakMap === 'function') ? new WeakMap() : null;

function gpPlanOpportunities(doc) {
  if (!doc || !doc.querySelectorAll) return null;
  if (_gpPlanCache && _gpPlanCache.has(doc)) return _gpPlanCache.get(doc);

  var headers = [].slice.call(doc.querySelectorAll('tr.PageHeaderContacts'));
  var plan = null;

  if (headers.length) {
    var currentId = gpCurrentDealId();
    var cutoff = gpPriorOppCutoffMs();
    var keep = {}, drop = {}, blocks = [];
    var anchored = false;

    for (var i = 0; i < headers.length; i++) {
      var row = headers[i];
      var id = gpOppIdFromHeaderRow(row);
      var when = gpNewestActivityMs(cleanText(row.textContent));
      var reason;

      if (currentId && id && id === currentId) {
        reason = 'current-deal';        // rule 1 — always, regardless of age
        anchored = true;
      } else if (when !== null && when >= cutoff) {
        reason = 'recent-prior';        // rule 2 — still warm
      } else {
        reason = 'stale-prior';
      }

      var keeping = (reason !== 'stale-prior');
      if (id) { (keeping ? keep : drop)[id] = true; }
      blocks.push({
        oppId: id, index: i, reason: reason, kept: keeping,
        headerDate: (when === null ? null : new Date(when).toISOString()),
      });
    }

    // Fallback for rule 1: the current deal id was unreadable or no block
    // matched it (renamed opportunity, merged record, markup change). Keep
    // the FIRST block — eLead prints newest first, so that is the live deal.
    // Without this a markup change would silently drop every block.
    if (!anchored && blocks.length) {
      var first = blocks[0];
      if (!first.kept) {
        first.kept = true;
        first.reason = 'fallback-first-block';
        if (first.oppId) { keep[first.oppId] = true; delete drop[first.oppId]; }
      } else if (first.reason === 'recent-prior') {
        first.reason = 'fallback-first-block';
      }
    }

    plan = {
      currentDealId: currentId,
      anchoredOnDealId: anchored,
      priorOppDays: gpPriorOppDays(),
      keep: keep, drop: drop, blocks: blocks,
    };
  }

  if (_gpPlanCache) _gpPlanCache.set(doc, plan);
  return plan;
}

// Should this activity row be scraped at all? Combines the three rules
// into the single predicate every pass calls.
function gpKeepActivityRow(row, plan) {
  if (!row) return true;
  if (gpIsNestedLayoutRow(row)) return false;
  var cells = [].slice.call(row.querySelectorAll('td'))
    .map(function (c) { return cleanText(c.textContent); });
  var text = cleanText(row.textContent);
  if (gpIsMegaRow(cells, text)) return false;          // rule 4
  var scope = gpRowScope(row, plan);
  if (scope === 'drop-opp') return false;              // rules 1 + 2
  if (scope === 'in-opp') return true;                 // whole deal, any age
  return gpRowInWindow(cells, text);                   // rule 3
}

// The one call site everything shares.
//   'drop-opp'  → row belongs to an opportunity we're skipping whole
//   'in-opp'    → row belongs to a kept opportunity; NO date filter, the
//                 whole deal comes through however old it is
//   'ungrouped' → not under any opportunity; the date window applies
function gpRowScope(row, plan) {
  if (!plan) return 'ungrouped';
  if (gpIsOppHeaderRow(row)) {
    var hid = gpOppIdFromHeaderRow(row);
    if (hid && plan.drop[hid]) return 'drop-opp';
    if (hid && plan.keep[hid]) return 'in-opp';
    return 'ungrouped';
  }
  var oid = gpOppIdForRow(row);
  if (!oid) return 'ungrouped';
  return plan.drop[oid] ? 'drop-opp' : 'in-opp';
}

// ── Top completed activity ──────────────────────────────────────
// Mirrors the server's caParseActivityRow (scraper-server/server.js) so the
// scraper can emit `currentActivity` directly instead of the server having
// to re-derive it from tableRows. A real completed-activity row starts with
// the expander icon and ends with the "launch" action link; that shape is
// what separates it from scheduled rows ("check edit"), opportunity header
// rows ("keyboard_arrow_up" … "N") and mega rows.
function gpParseActivityRow(rawCells) {
  var cells = (rawCells || []).map(function (c) {
    return String(c == null ? '' : c).trim();
  });
  if (cells.length < 4) return null;
  if (cells[0].toLowerCase() !== 'keyboard_arrow_down') return null;
  if (cells[cells.length - 1].toLowerCase() !== 'launch') return null;

  var dtIdx = -1;
  for (var i = 0; i < cells.length; i++) {
    if (GP_ACTIVITY_DT_RE.test(cells[i]) &&
        /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*[AP]M$/i.test(cells[i])) {
      dtIdx = i; break;
    }
  }
  if (dtIdx === -1) return null;

  var dtParts = cells[dtIdx].split(/\s+/);
  var date = dtParts.shift() || '';
  var time = dtParts.join(' ');
  var completedBy = cells[cells.length - 2] || '';

  // eLead prints the activity type twice; drop consecutive dupes and any
  // bare URL that leaks in from a CallDrip row.
  var middle = cells.slice(dtIdx + 1, cells.length - 2)
    .filter(function (c, i, arr) { return i === 0 || c !== arr[i - 1]; })
    .filter(function (c) { return !/^https?:\/\//i.test(c); });

  var activityType = middle[0] || '';
  if (!activityType && !date) return null;
  return {
    date: date,
    time: time,
    activityType: activityType,
    outcome: middle[1] || '',
    comment: middle.slice(2).join(' ').trim(),
    completedBy: completedBy,
  };
}

// TRUE only for the tabs that render an activity-history table. The Audit
// Trail is deliberately NOT one of them: its "Added <name> to the sales team
// as a <role>" lines are how we resolve a rep's role when the Sales Teams
// panel is thin, and those entries are old by nature. Detection is by content
// rather than URL because eLead serves the tabs into an iframe whose src is
// often blank by the time we read it.
//
// Feed this textContent, never innerText: innerText is layout-dependent and is
// undefined in non-rendering contexts, and a false here silently switches the
// window filter OFF for the one tab that needs it most.
function gpIsHistoryDoc(bodyText) {
  return /(Completed|Service|Other)\s*Activity\s*History/i.test(String(bodyText || ''));
}

// Line-level window filter for a history tab's visible text. Lines carrying an
// out-of-window activity datetime are dropped; every other line (headers,
// totals, labels) is kept, so the shape of the text stays readable.
function gpTrimHistoryText(text) {
  var cutoff = gpCutoffMs();
  var lines = String(text || '').split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var when = gpNewestActivityMs(lines[i]);
    if (when !== null && when < cutoff) continue;
    out.push(lines[i]);
  }
  return out.join('\n');
}

// eLead prints history newest-first, so the first parseable row wins.
function gpTopActivityFromRows(rows) {
  if (!Array.isArray(rows)) return null;
  for (var i = 0; i < rows.length; i++) {
    if (!Array.isArray(rows[i])) continue;
    var a = gpParseActivityRow(rows[i]);
    if (a) return a;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
// AUTO-CLICK MENUBAR ACTION (Phone / Text)
// ────────────────────────────────────────────────────────────────
// Background dispatches AUTO_CLICK_ACTION after a Call or Text button
// on the side panel opens this lead page. We poll for the right
// element (the menubar finishes assembling a beat after page load)
// and click it. Returns true once the click is dispatched, false if
// the element never appears.
// ════════════════════════════════════════════════════════════════
function autoClickMenubarAction(action) {
  // Selectors mirror the eLead markup the user provided:
  //   Phone:  <a class="menubarlink x_phone" ...>
  //   Text :  <div id="textSingleCustomerChat"> ... </div>
  const selectors = action === 'phone'
    ? ['a.menubarlink.x_phone', '.menubarlink.x_phone']
    : action === 'text'
    ? ['#textSingleCustomerChat']
    : null;
  if (!selectors) return Promise.resolve(false);

  // Already-clicked guard so two frames or a stray re-dispatch can't
  // double-fire (e.g. opening two phone modals).
  const guardKey = '__gpAutoClicked_' + action;
  if (window[guardKey]) return Promise.resolve(true);

  return new Promise((resolve) => {
    const maxAttempts = 60;       // ~12s total
    const intervalMs = 200;
    let attempts = 0;

    function tryClick() {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // hidden / not laid out yet
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        window[guardKey] = true;
        try { el.click(); }
        catch (_) {
          try {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          } catch (__) { /* ignore */ }
        }
        return true;
      }
      return false;
    }

    if (tryClick()) return resolve(true);
    const id = setInterval(() => {
      attempts++;
      if (tryClick()) { clearInterval(id); resolve(true); return; }
      if (attempts >= maxAttempts) { clearInterval(id); resolve(false); }
    }, intervalMs);
  });
}

// ════════════════════════════════════════════════════════════════
// 1. MAIN PAGE SCRAPER (OpptyDetails.aspx)
// ════════════════════════════════════════════════════════════════
function scrapeMainPage() {
  const doc = document;
  const gData = extractGData();
  const personId = getUrlParam('lPID') || gData.CustomerId?.toString() || getTextById('CustomerInfoPanel_lblPersonID');
  const dealId = getUrlParam('lDID') || gData.OpportunityId?.toString() || '';

  // ── Customer ──
  const customer = {
    name: getFieldValue('CustomerInfoPanel_NameLink') || ((gData.FirstName || '') + ' ' + (gData.LastName || '')).trim(),
    firstName: gData.FirstName || '', lastName: gData.LastName || '',
    personId: getTextById('CustomerInfoPanel_lblPersonID') || gData.CustomerId?.toString() || '',
    address: getFieldValue('CustomerInfoPanel_AddressLink'),
    cityStateZip: getCityStateZip(),
    homePhone: getPhone('CustomerInfoPanel_HPhoneLink'),
    cellPhone: getPhone('CustomerInfoPanel_CPhoneLink'),
    workPhone: getPhone('CustomerInfoPanel_WPhoneLink'),
    preferredEmail: getEmail('CustomerInfoPanel_PrefEmailLink') || gData.PrimaryEmail || '',
    otherEmail: getEmailByLabel('Other Email'),
    birthday: getFieldValue('CustomerInfoPanel_BdayLink'),
    preferredLanguage: getFieldValue('CustomerInfoPanel_PrefLanguageLink'),
    lastModified: getLabelValue('Last Modified'),
    serviceDollar: getLabelValue('Service'),
    purchasesDollar: getLabelValue('Purchases'),
    highPriority: isChecked('CustomerInfoPanel_HighPriorityCheckBox'),
    textPreferred: isChecked('CustomerInfoPanel_TextPreferredCheckBox'),
    doNotText: !!doc.querySelector('img[title*="Do not text"], img[alt*="Do not text"]'),
    preferredContactMethod: doc.querySelector('img[alt*="Preferred Method of Contact"]') ? 'phone' : null,
  };
  if (!customer.firstName && customer.name) {
    const p = splitName(customer.name); customer.firstName = p.firstName; customer.lastName = p.lastName;
  }

  // ── Opportunity (visible panel, even if display:none for sold leads) ──
  const noActiveMsg = getNoActiveOpptyMessage();
  const salesTeam = getSalesTeam(); // parse once, reused for sales_rep below
  const opportunity = {
    hasActiveOpportunity: !noActiveMsg,
    noActiveOpptyMessage: noActiveMsg || null,
    vehicle: getVehicleInfo(),
    stockNumber: getStockText() || getFieldValue('OpportunityPanel_StockLink'),
    stockAvailability: getStockAvailability(),
    trade: getFieldValue('OpportunityPanel_TradeInLink'),
    salesTeam,                          // existing field, unchanged
    sales_rep: getSalesReps(salesTeam), // new: [{ name, type, role }]
    upType: getFieldValue('OpportunityPanel_UpTypeLink'),
    source: gData.Source || getFieldValue('OpportunityPanel_SourceLink'),
    sourceDetails: gData.SourceDetails || '',
    sourceCategory: gData.SourceCategoryId || '',
    dateTimeDue: getLabelValue('Date/Time Due'),
    salesStatus: getSelectedOption('OpportunityPanel_StatusDropdown'),
    salesStatusCategory: getStatusCategory(),
    salesSteps: getSalesSteps(),
    statusFlag: getStatusFlag(),
    inShowroom: gData.InShowroom || false,
  };

  // ── VehicleSought from g_data (structured vehicle info) ──
  const vehicleSought = gData.VehicleSought || null;

  // ── Notes ──
  const notes = scrapeNotes();

  // ── Previous Opportunity ──
  const previousOpportunity = getPreviousOpportunityInfo();

  // ── Tabs ──
  const tabs = getTabNames();

  // ── All label:value pairs ──
  const allFieldPairs = getAllLabelValuePairs();

  // ── Clean g_data ──
  const gDataClean = { ...gData };
  delete gDataClean.ImpersonatedUserID; delete gDataClean.CurrentUserId;

  // ── CallDrip URLs + Activity Log ──
  // Pass the sales team through so each call can be typed salesperson /
  // bdc / other from the "Completed By" name on its activity row.
  const callDrip = scrapeCallDripData(opportunity.sales_rep);

  // ── Top Menu Bar Actions ──
  const menuBar = scrapeMenuBar();

  return {
    scrapedAt: new Date().toISOString(), pageTitle: doc.title || '',
    pageUrl: doc.location?.href || '', extractionMethod: 'dom-scrape',
    personId, dealId,
    customer, opportunity, vehicleSought, notes, previousOpportunity,
    tabs, menuBar, allFieldPairs, gData: gDataClean,
    callDripUrls: callDrip.urls,
    activityLog: callDrip.activities,
  };
}

// ════════════════════════════════════════════════════════════════
// 2. FIND ALL SUB-PAGE URLs FROM MAIN PAGE
// ════════════════════════════════════════════════════════════════
function findAllSubPageUrls() {
  const urlMap = new Map(); // url → {url, type, label}
  const gData = extractGData();
  const base = gpCrmOrigin();

  function addUrl(url, type, label) {
    const clean = String(url || '').split('#')[0];
    // Host-agnostic: was `clean.includes('eleadcrm.com')`, which rejected
    // every link discovered from the live crm.connectcdk.com DOM.
    if (clean && gpIsCrmUrl(clean) && !urlMap.has(clean)) {
      urlMap.set(clean, { url: clean, type, label });
    }
  }

  const did = gData.OpportunityId || getUrlParam('lDID');
  const pid = gData.CustomerId || getUrlParam('lPID');
  const cid = gData.CompanyId || gData.ChildCompanyId;
  const soldDealId = gData.SoldInventoryDealId;

  // Quote page
  if (did && pid && cid) {
    addUrl(base + '/app/desking/pages/legacyquote.aspx?lDealID=' + did + '&lPersonID=' + pid + '&lChildCompanyID=' + cid, 'quote', 'Quote / Desking');
  }

  // SoldHistory from DOM links (a tags with href or onclick)
  document.querySelectorAll('a[href*="SoldHistory"], a[onclick*="SoldHistory"]').forEach(a => {
    const href = a.href || '';
    if (href.includes('SoldHistory.asp')) addUrl(href, 'soldHistory', 'Sold / Purchase History');
    const onclick = a.getAttribute('onclick') || '';
    const match = onclick.match(/SoldHistory\.asp[^'"\\s]*/);
    if (match) addUrl(base + '/evo2/fresh/elead-v45/elead_track/newprospects/' + match[0], 'soldHistory', 'Sold / Purchase History');
  });

  // SoldHistory from doSoldHistory(ID) onclick handlers on ANY element (td, tr, a, etc.)
  // Only take the MOST RECENT (first in DOM order = top of activity log)
  {
    const doSoldEls = document.querySelectorAll('[onclick*="doSoldHistory"]');
    if (doSoldEls.length > 0) {
      const firstEl = doSoldEls[0]; // Most recent entry (top of activity log)
      const onclick = firstEl.getAttribute('onclick') || '';
      const idMatch = onclick.match(/doSoldHistory\s*\(\s*(\d+)\s*\)/);
      if (idMatch) {
        const soldId = idMatch[1];
        // LICID = ChildCompanyId, also try extracting from page URL or gData
        const licid = cid || getUrlParam('LICID') || getUrlParam('lChildCompanyID') || '';
        let soldUrl = base + '/evo2/fresh/elead-v45/elead_track/newprospects/SoldHistory.asp?';
        if (licid) soldUrl += 'LICID=' + licid + '&';
        soldUrl += 'ID=' + soldId;
        addUrl(soldUrl, 'soldHistory', 'Sold / Purchase History');
        console.log('[eLead Scraper] Found doSoldHistory ID=' + soldId + ', LICID=' + licid + ' (most recent, from <' + firstEl.tagName.toLowerCase() + '>)');
      }
    }
  }

  // SoldHistory from script tags
  document.querySelectorAll('script').forEach(script => {
    const text = script.textContent || '';
    for (const m of text.matchAll(/SoldHistory\.asp\?[^'"\\s)]+/g)) {
      addUrl(base + '/evo2/fresh/elead-v45/elead_track/newprospects/' + m[0], 'soldHistory', 'Sold / Purchase History');
    }
  });

  // CompletedEdit links
  document.querySelectorAll('a[href*="CompletedEdit"], a[onclick*="CompletedEdit"]').forEach(a => {
    if (a.href && a.href.includes('CompletedEdit')) addUrl(a.href, 'completedEdit', 'Completed Edit');
  });

  // VehicleStatus links
  document.querySelectorAll('script').forEach(script => {
    const text = script.textContent || '';
    for (const m of text.matchAll(/VehicleStatus\.asp\?[^'"\\s)]+/g)) {
      addUrl(base + '/evo2/fresh/elead-v45/elead_track/NewProspects/' + m[0], 'vehicleStatus', 'Vehicle Status');
    }
  });

  // window.open patterns
  document.querySelectorAll('[onclick]').forEach(el => {
    const onclick = el.getAttribute('onclick') || '';
    const winOpen = onclick.match(/window\.open\s*\(\s*["']([^"']*(?:SoldHistory|CompletedEdit|ViewDeal|legacyquote)[^"']*)/i);
    if (winOpen) {
      let u = winOpen[1];
      if (u.startsWith('/')) u = base + u;
      else if (u.startsWith('../')) u = base + '/evo2/fresh/elead-v45/elead_track/' + u.replace('../', '');
      const type = classifyUrl(u);
      addUrl(u, type.type, type.label);
    }
  });

  // ── Text Message (Messenger chat) — extract clientUrl from inline script ──
  // The "Text Message" button calls window.open(clientUrl, "TextMessageChat", ...).
  // clientUrl is a JS variable in the page containing a JWT-tokenized URL into
  // /rt/MessengerClient/Home/Index. We just regex it out — no click needed.
  {
    const html = document.documentElement.outerHTML || '';
    const m = html.match(/var\s+clientUrl\s*=\s*"([^"]+)"/);
    if (m && m[1] && m[1].trim() !== '') {
      let url = m[1];
      if (url.startsWith('/')) url = base + url;
      addUrl(url, 'textMessages', 'Text Message Chat');
    }
  }

  return [...urlMap.values()].filter(item => {
    if (/ViewDealOn180/i.test(item.url)) return false;
    // Skip SoldHistory URLs with empty/missing ID
    if (/SoldHistory/i.test(item.url) && /[&?]ID=(&|$)/i.test(item.url)) return false;
    return true;
  });
}

/** Classify a URL by its page type */
function classifyUrl(url) {
  if (/SoldHistory/i.test(url)) return { type: 'soldHistory', label: 'Sold / Purchase History' };
  if (/legacyquote|Quote\.aspx/i.test(url)) return { type: 'quote', label: 'Quote / Desking' };
  if (/ViewDealOn180/i.test(url)) return { type: 'dealView', label: 'Deal View' };
  if (/CompletedEdit/i.test(url)) return { type: 'completedEdit', label: 'Completed Edit' };
  if (/VehicleStatus/i.test(url)) return { type: 'vehicleStatus', label: 'Vehicle Status' };
  if (/MessengerClient|TextMessageChat/i.test(url)) return { type: 'textMessages', label: 'Text Message Chat' };
  if (/OpptyDetails/i.test(url)) return { type: 'prospect', label: 'Prospect / Lead Detail' };
  return { type: 'other', label: 'Other' };
}

/** Scrape the top menu bar actions (eBrochure, Email, Quote, Credit App, etc.) */
function scrapeMenuBar() {
  const actions = [];
  const seen = new Set();
  document.querySelectorAll('.menubarlink').forEach(el => {
    const classes = el.className || '';
    const typeMatch = classes.match(/x_(\w+)/);
    const actionType = typeMatch ? typeMatch[1] : '';
    const text = cleanText(el.textContent);
    if (!actionType || seen.has(actionType)) return;
    seen.add(actionType);
    actions.push({ action: actionType, label: text || actionType });
  });
  return actions;
}

// ════════════════════════════════════════════════════════════════
// 3. GENERIC PAGE SCRAPER (SoldHistory, Quote, any sub-page)
// ════════════════════════════════════════════════════════════════
function scrapeAnyPage() {
  const doc = document;
  const result = {
    pageUrl: doc.location?.href || '',
    pageTitle: doc.title || '',
    scrapedAt: new Date().toISOString(),
  };

  // ── Identify page type ──
  const url = doc.location?.href || '';
  if (url.includes('SoldHistory')) result.pageType = 'soldHistory';
  else if (url.includes('legacyquote') || url.includes('Quote')) result.pageType = 'quote';
  else if (url.includes('ViewDealOn180')) result.pageType = 'dealView';
  else if (url.includes('CompletedEdit')) result.pageType = 'completedEdit';
  else if (url.includes('VehicleStatus')) result.pageType = 'vehicleStatus';
  else if (url.includes('MessengerClient') || url.includes('TextMessageChat')) result.pageType = 'textMessages';
  else result.pageType = 'unknown';

  // ── Scrape all table label:value pairs ──
  result.allFieldPairs = scrapeAllTablePairs();

  // ── For SoldHistory: extract structured sections ──
  if (result.pageType === 'soldHistory') {
    const p = result.allFieldPairs;
    result.purchasedVehicle = pick(p, {
      'vehiclePurchased': ['Vehicle Purchased', 'Vehicle  Purchased'],
      'vin': ['VIN'], 'stockNumber': ['Stock Number'], 'mileage': ['Mileage'],
      'salesperson': ['Salesperson'], 'dateSold': ['Date Sold'],
      'newUsed': ['New/Used'], 'leasePurchase': ['Lease/Purchase'],
      'deliveryStatus': ['Delivery Status'], 'vehicleStatus': ['Vehicle Status'],
    });
    result.tradeIn = pick(p, {
      'vehicleTraded': ['Vehicle Traded', 'Vehicle  Traded'],
      'tradeVin': ['Trade VIN', 'VIN'], 'tradeStockNumber': ['Trade Stock Number', 'Stock Number'],
      'allowance': ['Allowance'], 'payoff': ['Payoff'],
      'tradeMileage': ['Trade Mileage', 'Mileage'],
    });
    result.purchaseInfo = pick(p, {
      'purchasePrice': ['Purchase Price'], 'frontGross': ['Front Gross'],
      'totalGross': ['Total Gross'], 'downPayment': ['Down Payment'],
      'financeAmount': ['Finance Amount'], 'rate': ['Rate'], 'term': ['Term'],
      'warranty': ['Warranty'], 'warrantyCost': ['Warranty Cost'],
      'financedThrough': ['Financed Through'], 'backGross': ['Back Gross'],
      'dealerProfit': ['Dealer Profit'], 'dateOfFirstPayment': ['Date of First Payment'],
      'monthlyPayment': ['Monthly Payment'], 'dateOfLastPayment': ['Date of Last Payment'],
      'lastPaymentAmount': ['Last Payment Amount'],
      'totalTradeAllowance': ['Total Trade Allowance'],
      'totalTradePayoff': ['Total Trade Payoff'],
      'fAndIManager': ['F&I Manager', 'F & I Manager'],
    });
    // Get customer name from page header
    const header = doc.querySelector('.backgroundColor .headingWhite_14px, .backgroundColor td');
    if (header) result.headerText = cleanText(header.textContent);
  }

  // ── For Quote: extract form field values ──
  if (result.pageType === 'quote') {
    const formFields = {};
    doc.querySelectorAll('input[id^="txt"], input[id^="hdn"], select').forEach(el => {
      const id = el.id || el.name || '';
      let val = '';
      if (el.tagName === 'SELECT') {
        val = el.options[el.selectedIndex]?.textContent?.trim() || '';
      } else {
        val = el.value || '';
      }
      if (id && val && val !== '0' && val !== '0.00') {
        const name = id.replace(/^(txt|hdn)/, '');
        formFields[name] = val;
      }
    });
    result.quoteFormFields = formFields;

    // Labels with values
    doc.querySelectorAll('[id^="lbl"]').forEach(el => {
      const id = el.id.replace('lbl', '');
      const val = cleanText(el.textContent);
      if (val && val.length < 300) result.allFieldPairs['label_' + id] = val;
    });

    // Get quote metadata from JS vars
    const scripts = doc.querySelectorAll('script');
    for (const s of scripts) {
      const t = s.textContent || '';
      const oid = t.match(/opportunity_id\s*=\s*(\d+)/);
      if (oid) result.opportunityId = oid[1];
      const empName = t.match(/employee_name\s*=\s*"([^"]+)"/);
      if (empName) result.employeeName = empName[1];
    }
  }

  // ── For textMessages: extract structured conversation ──
  if (result.pageType === 'textMessages') {
    const msgData = scrapeTextMessagesPage();
    Object.assign(result, msgData);
  }

  // ── Full visible text (capped) ──
  result.fullText = cleanText(doc.body?.innerText || '').substring(0, 50000);

  return result;
}

// ════════════════════════════════════════════════════════════════
// 4. CALLDRIP URLs + ACTIVITY LOG SCANNER
// ════════════════════════════════════════════════════════════════
function scrapeCallDripData(salesReps) {
  // The Sales Teams panel is what tells us who is a salesperson and who is
  // BDC, so parse it before walking the activity rows.
  const reps = Array.isArray(salesReps) ? salesReps : getSalesReps(getSalesTeam());
  const repIndex = buildRepIndex(reps);

  const urls = new Map();   // url → { url, callId, type, ... }
  const activities = [];

  // Scan current document for calldrip.com links
  scanDocForCallDrip(document, urls, activities, repIndex);

  // Try to access iframes (tabs content, activity logs)
  try {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iDoc) scanDocForCallDrip(iDoc, urls, activities, repIndex);
      } catch (e) { /* cross-origin — handled by all_frames */ }
    }
  } catch (e) {}

  return { urls: [...urls.values()], activities };
}

// Record (or upgrade) one CallDrip URL. Rows are walked more than once by
// the passes below, and only some of those passes know who completed the
// row — so a later pass carrying a real attribution is allowed to fill in
// an entry that was first seen without one. A resolved type is never
// downgraded back to 'other'.
function noteCallDripUrl(urls, url, attribution) {
  if (!url) return;
  const existing = urls.get(url);
  const meta = attribution || null;
  const resolved = meta && meta.typeSource !== 'no-agent';
  if (!existing) {
    urls.set(url, {
      url,
      callId: callDripIdFromUrl(url),
      type: (meta && meta.type) || 'other',
      repType: (meta && meta.repType) || 'other',
      agentName: (meta && meta.agentName) || '',
      matchedRepName: (meta && meta.matchedRepName) || '',
      role: (meta && meta.role) || '',
      typeSource: (meta && meta.typeSource) || 'no-agent',
    });
    return;
  }
  const hadAgent = existing.typeSource && existing.typeSource !== 'no-agent';
  if (resolved && !hadAgent) {
    existing.type = meta.type;
    existing.repType = meta.repType;
    existing.agentName = meta.agentName;
    existing.matchedRepName = meta.matchedRepName;
    existing.role = meta.role;
    existing.typeSource = meta.typeSource;
  }
}

function scanDocForCallDrip(doc, urls, activities, repIndex) {
  // A frame that hosts its own opportunity panel gets its own team; the
  // history iframe usually has none, so it falls back to the caller's.
  let index = repIndex;
  if (!index || !index.length) {
    try {
      const local = buildRepIndex(getSalesReps(getSalesTeam(doc)));
      if (local.length) index = local;
    } catch (e) { /* not an opportunity page */ }
  }

  // Which opportunity blocks is this document contributing? Computed once
  // and shared by all three passes below (cached per-document).
  const plan = gpPlanOpportunities(doc);

  // ── Find all calldrip.com links ──
  doc.querySelectorAll('a[href*="calldrip.com"], a[href*="CallDrip"], a[href*="calldrip"]').forEach(a => {
    const href = a.href || '';
    if (!href.includes('calldrip')) return;

    // Try to get the activity row context around this link
    const row = a.closest('tr');

    // HISTORY SCOPE: a CallDrip link on a row belonging to a skipped
    // opportunity is dropped entirely — not just the activity entry, the URL
    // too, so the server never fetches its transcript and nothing downstream
    // can treat a closed deal's voicemail as evidence about who is working
    // THIS lead. Rows inside a kept opportunity are never date-filtered.
    if (row && !gpKeepActivityRow(row, plan)) return;

    const who = resolveRepType(getRowAgentName(row), index);
    noteCallDripUrl(urls, href, who);

    if (row) {
      const cells = row.querySelectorAll('td');
      const rowText = [...cells].map(c => cleanText(c.textContent)).filter(Boolean);
      activities.push({
        callDripUrl: href,
        rowData: rowText,
        rawText: cleanText(row.textContent),
        completedBy: who.agentName,
        type: who.type,
        repType: who.repType,
        matchedRepName: who.matchedRepName,
        role: who.role,
        typeSource: who.typeSource,
      });
    }
  });

  // ── Scan all table rows for activity log entries (calls, emails, etc.) ──
  // NOTE: this runs BEFORE the whole-body sweep below. eLead prints the
  // CallDrip link as plain text in the comment cell (not an <a href>), so
  // the row walk is the only pass that can see both the URL and the
  // "Completed By" cell that tells us whose call it was.
  doc.querySelectorAll('table tr').forEach(row => {
    const text = row.textContent || '';
    // Look for rows with calldrip references
    if (/calldrip/i.test(text)) {
      // HISTORY SCOPE — same gate as the anchor pass above. This also kills
      // the "mega rows" where eLead flattens a whole closed opportunity into
      // one cell: those carry every CallDrip URL of that opportunity as bare
      // text, so without this check a single mega row re-imports the entire
      // lifetime of calls the anchor pass just filtered out.
      if (!gpKeepActivityRow(row, plan)) return;

      const cells = row.querySelectorAll('td');
      const rowData = [...cells].map(c => cleanText(c.textContent)).filter(Boolean);
      const who = resolveRepType(getRowAgentName(row), index);

      // Every calldrip URL in this row — href or bare text — is credited
      // to the person who completed the row.
      const link = row.querySelector('a[href*="calldrip"]');
      const rowUrls = extractCallDripUrls(row.innerHTML || '');
      if (link?.href && !rowUrls.includes(link.href)) rowUrls.unshift(link.href);
      for (const u of rowUrls) noteCallDripUrl(urls, u, who);

      const url = link?.href || rowUrls[0] || '';
      // Avoid duplicates
      const rawText = cleanText(row.textContent);
      if (!activities.find(a => a.rawText === rawText)) {
        activities.push({
          callDripUrl: url, rowData, rawText,
          completedBy: who.agentName,
          type: who.type,
          repType: who.repType,
          matchedRepName: who.matchedRepName,
          role: who.role,
          typeSource: who.typeSource,
        });
      }
    }
  });

  // ── Sweep the whole document for any calldrip URL the row passes missed ──
  // These have NO row context, therefore no date and no "Completed By" — we
  // cannot tell whether such a URL belongs to today's deal or to a deal that
  // closed in 2019. It is exactly this undated catch-all that re-imports the
  // customer's entire call history after the windowed passes above filtered
  // it out, so it is OFF by default. Flip window.__gpCallDripSweepUndated to
  // true only when debugging a "missing call" report.
  if (window.__gpCallDripSweepUndated === true) {
    for (const u of extractCallDripUrls(doc.body?.innerHTML || '')) {
      noteCallDripUrl(urls, u, null);
    }
  }

  // ── Also grab general activity/call log entries ──
  doc.querySelectorAll('table tr').forEach(row => {
    const text = row.textContent || '';
    // Match rows that look like call activity: date, phone number, duration patterns
    if (/(?:Outbound|Inbound|Missed)\s*Call/i.test(text) || /\d{2}:\d{2}\s*(?:AM|PM).*\(\d{3}\)\s*\d{3}-\d{4}/i.test(text)) {
      // HISTORY SCOPE — skipped-opportunity rows and mega rows never enter
      // activityLog.
      if (!gpKeepActivityRow(row, plan)) return;

      const cells = row.querySelectorAll('td');
      const rowData = [...cells].map(c => cleanText(c.textContent)).filter(Boolean);

      const links = row.querySelectorAll('a[href]');
      const externalUrls = [...links].map(a => a.href).filter(h => h && h.startsWith('http') && !gpIsCrmUrl(h));
      const rawText = cleanText(row.textContent);
      if (!activities.find(a => a.rawText === rawText)) {
        const who = resolveRepType(getRowAgentName(row), index);
        activities.push({
          callDripUrl: externalUrls[0] || '', rowData, rawText, externalUrls,
          completedBy: who.agentName,
          type: who.type,
          repType: who.repType,
          matchedRepName: who.matchedRepName,
          role: who.role,
          typeSource: who.typeSource,
        });
      }
    }
  });
}

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

function scrapeAllTablePairs() {
  const pairs = {};
  // Strategy 1: adjacent td where first has label pattern
  document.querySelectorAll('table tr').forEach(row => {
    const cells = row.querySelectorAll('td, th');
    for (let i = 0; i < cells.length - 1; i++) {
      const raw = cells[i].textContent?.trim() || '';
      // "Label:" or "Label: " pattern
      const m = raw.match(/^([A-Za-z\s\/\-#&().]+?)\s*:\s*$/);
      if (m && m[1].length > 1 && m[1].length < 60) {
        const key = m[1].trim();
        const val = cleanText(cells[i + 1].textContent);
        if (val && val.length < 500 && !pairs[key]) pairs[key] = val;
      }
      // Also "Label:  Value" in same cell pair
      const inline = raw.match(/^([A-Za-z\s\/\-#&().]+?)\s*:\s+(.+)/);
      if (inline && inline[1].length < 60 && !pairs[inline[1].trim()]) {
        pairs[inline[1].trim()] = cleanText(inline[2]);
      }
    }
  });
  // Strategy 2: data-i18n labeled fields
  document.querySelectorAll('[data-i18n]').forEach(span => {
    const raw = span.textContent?.trim() || '';
    const m = raw.match(/^([A-Za-z\s\/\-#&().]+?)\s*:\s*$/);
    if (!m) return;
    const key = m[1].trim();
    if (key.length < 2 || key.length > 50) return;
    const td = span.closest('td');
    if (!td) return;
    const nextTd = td.nextElementSibling;
    if (!nextTd) return;
    const val = cleanText(nextTd.textContent);
    if (val && val.length < 500 && !pairs[key]) pairs[key] = val;
  });
  return pairs;
}

function pick(source, mapping) {
  const result = {};
  for (const [outKey, candidates] of Object.entries(mapping)) {
    for (const c of candidates) {
      if (source[c]) { result[outKey] = source[c]; break; }
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function extractGData() {
  try {
    // Try direct access (works if executeScript runs in main world)
    if (window.g_data && typeof window.g_data === 'object') return JSON.parse(JSON.stringify(window.g_data));

    // Parse from script tags
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      const startIdx = text.indexOf('var g_data = {');
      if (startIdx === -1) continue;

      // Brace-match to find the full object (handles nested {}, [])
      let depth = 0; let inStr = false; let strChar = '';
      const start = text.indexOf('{', startIdx);
      let end = -1;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) { if (c === strChar && text[i-1] !== '\\') inStr = false; continue; }
        if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end === -1) continue;

      const raw = text.substring(start, end);
      // Try JSON parse after adding quotes to keys
      try {
        const jsonStr = raw
          .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
          .replace(/:(\s*)\\/g, ':"\\')   // fix Date strings
          .replace(/,\s*([}\]])/g, '$1');  // remove trailing commas
        return JSON.parse(jsonStr);
      } catch (e) {
        // Fallback: extract fields individually
        return extractGDataFields(text.substring(startIdx, end));
      }
    }
  } catch (e) {}
  return {};
}

function extractGDataFields(str) {
  const data = {};
  const fields = [
    ['CompanyId',/CompanyId:(\d+)/], ['ChildCompanyId',/ChildCompanyId:(\d+)/],
    ['CustomerId',/CustomerId:(\d+)/], ['OpportunityId',/OpportunityId:"?(\d+)"?/],
    ['StatusId',/StatusId:(\d+)/], ['CustomerNameEncoded',/CustomerNameEncoded:"([^"]+)"/],
    ['SalesPersonId',/SalesPersonId:"?(\w+)"?/], ['TradeInId',/TradeInId:"([^"]*)"/],
    ['Source',/Source:"([^"]*)"/], ['SourceDetails',/SourceDetails:"([^"]*)"/],
    ['SourceCategoryId',/SourceCategoryId:"?(\w+)"?/],
    ['FirstName',/FirstName:"([^"]*)"/], ['LastName',/LastName:"([^"]*)"/],
    ['PrimaryEmail',/PrimaryEmail:"([^"]*)"/],
    ['PhoneNumber',/PhoneNumber:"([^"]*)"/], ['AreaCode',/AreaCode:"([^"]*)"/],
    ['CellPhoneNumber',/CellPhoneNumber:"([^"]*)"/], ['CellAreaCode',/CellAreaCode:"([^"]*)"/],
    ['DesklogActivityId',/DesklogActivityId:"([^"]*)"/],
    ['NextScheduledActivityId',/NextScheduledActivityId:"([^"]*)"/],
    ['InShowroom',/InShowroom:(true|false)/],
    ['SoldInventoryDealId',/SoldInventoryDealId:(\d+)/],
    ['HasEdesk',/HasEdesk:(true|false)/],
    ['IsManager',/IsManager:(true|false)/],
    ['CanUnwindSold',/CanUnwindSold:(true|false)/],
  ];
  for (const [key, regex] of fields) {
    const m = str.match(regex);
    if (m) {
      let v = m[1];
      if (v === 'true') v = true; else if (v === 'false') v = false;
      else if (/^\d+$/.test(v)) v = parseInt(v);
      data[key] = v;
    }
  }
  // VehicleSought — brace-match the full nested object
  const vsStart = str.indexOf('VehicleSought:{');
  if (vsStart > -1) {
    const braceStart = str.indexOf('{', vsStart);
    let depth = 0; let end = -1;
    for (let i = braceStart; i < str.length; i++) {
      if (str[i] === '{' || str[i] === '[') depth++;
      else if (str[i] === '}' || str[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end > -1) {
      const vsRaw = str.substring(braceStart, end);
      try {
        const vsJson = vsRaw.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/,\s*([}\]])/g, '$1');
        data.VehicleSought = JSON.parse(vsJson);
      } catch (e) {}
    }
  }
  return data;
}

function getUrlParam(n) { try { return new URLSearchParams(window.location.search).get(n) || ''; } catch(e) { return ''; } }
function getTextById(id) { const el = document.getElementById(id); return el ? cleanText(el.textContent) : ''; }

function getFieldValue(linkId) {
  const link = document.getElementById(linkId); if (!link) return '';
  const td = link.closest('td'); if (!td) return '';
  const next = td.nextElementSibling; if (!next) return '';
  return cleanText(getVisibleText(next));
}

function getPhone(linkId) {
  const link = document.getElementById(linkId); if (!link) return '';
  const td = link.closest('td'); if (!td) return '';
  const next = td.nextElementSibling; if (!next) return '';
  const cl = next.querySelector('a[onclick*="Click2Call"]');
  if (cl) return cl.textContent.trim();
  const a = next.querySelector('a');
  if (a) { const t = a.textContent.trim(); if (/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(t)) return t; }
  return cleanText(getVisibleText(next));
}

function getEmail(linkId) {
  const link = document.getElementById(linkId); if (!link) return '';
  const td = link.closest('td'); if (!td) return '';
  const next = td.nextElementSibling; if (!next) return '';
  const cf = next.querySelector('[data-cfemail]');
  if (cf) { const d = decodeCfEmail(cf.getAttribute('data-cfemail')); if (d) return d; }
  const ml = next.querySelector('a[href*="mailto:"]');
  if (ml) return ml.textContent.trim().replace(/\[email\s*protected\]/gi, '');
  const m = next.textContent.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (m) return m[0];
  return cleanText(getVisibleText(next)).replace(/\[email\s*protected\]/gi, '').trim();
}

function getEmailByLabel(label) {
  const els = document.querySelectorAll('[data-i18n], span, td');
  for (const el of els) {
    const t = el.textContent?.trim() || '';
    if (new RegExp('^' + label, 'i').test(t) && t.length < 30) {
      const td = el.closest('td'); if (!td) continue;
      const next = td.nextElementSibling; if (!next) continue;
      const cf = next.querySelector('[data-cfemail]');
      if (cf) return decodeCfEmail(cf.getAttribute('data-cfemail'));
      const m = next.textContent.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (m) return m[0];
      return cleanText(getVisibleText(next)).replace(/\[email\s*protected\]/gi, '').trim();
    }
  }
  return '';
}

function decodeCfEmail(enc) {
  if (!enc) return '';
  try { const r = parseInt(enc.substr(0,2),16); let e=''; for(let i=2;i<enc.length;i+=2) e+=String.fromCharCode(parseInt(enc.substr(i,2),16)^r); return e; } catch(e) { return ''; }
}

function getCityStateZip() {
  const row = document.getElementById('CustomerInfoPanel_CityStateZipRow'); if (!row) return '';
  for (const td of row.querySelectorAll('td')) {
    const t = cleanText(td.textContent);
    if (t && t.length > 2 && !t.includes('Private Offer') && !t.includes('Ford Pass')) return t;
  }
  return '';
}

function getVehicleInfo() {
  // Get from visible truncated text or link
  const trunc = document.querySelector('.truncateText[title]');
  if (trunc) return trunc.getAttribute('title') || cleanText(trunc.textContent);
  return getFieldValue('OpportunityPanel_VehicleLink');
}

function getStockText() { const el = document.getElementById('stockText'); return el ? cleanText(getVisibleText(el)) : ''; }

// Stock availability indicator. eLead renders a <span id="lblStockAvailable">
// next to the stock # with class "icon-warning" + a `title` attribute when
// the unit is no longer available (sold elsewhere, transferred, removed
// from inventory).
//
// IMPORTANT: eLead keeps this span PERMANENTLY in the DOM with the warning
// classes ('redtext', 'icon-warning') attached — and toggles visibility via
// inline `style="display: none;"` or the `hidden` attribute. So we MUST
// check visibility before flagging. Otherwise every lead returns
// available=false (the classes are always there).
//
// Returns:
//   { available: true,  warning: '' }   normal — unit is on the lot
//   { available: false, warning: 'Vehicle is not available.' }
//   { available: null,  warning: '' }   span not on page (older eLead layout)
//
// The `available: null` case lets downstream code distinguish "we couldn't
// detect" from "we confirmed unavailable" — useful for not falsely
// flagging legacy pages.
function getStockAvailability() {
  const el = document.getElementById('lblStockAvailable');
  if (!el) return { available: null, warning: '' };

  // Visibility gate — eLead hides the warning span when stock IS available.
  // Three signals say "this warning is NOT being shown to the user":
  //   1. Inline `style="display: none"` (most common)
  //   2. Inline `style="visibility: hidden"`
  //   3. The HTML `hidden` attribute
  // We check the raw style string instead of getComputedStyle() because
  // the latter requires the element to be in a rendered layout tree —
  // not always true when the scraper extracts mid-load.
  const styleAttr = (el.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
  const isHidden = styleAttr.includes('display:none')
    || styleAttr.includes('visibility:hidden')
    || el.hasAttribute('hidden');
  if (isHidden) {
    return { available: true, warning: '' };
  }

  const hasWarning = el.classList.contains('icon-warning')
    || (el.className || '').includes('icon-warning');
  const title = (el.getAttribute('title') || '').trim();
  // Some eLead versions also use 'redtext' as the warning marker
  const isRedText = (el.className || '').includes('redtext');
  if (hasWarning || isRedText || title) {
    return { available: false, warning: title || 'Stock flagged unavailable' };
  }
  return { available: true, warning: '' };
}
function getSelectedOption(id) { const s = document.getElementById(id); if (!s || s.selectedIndex < 0) return ''; return s.options[s.selectedIndex]?.textContent?.trim() || ''; }
function getStatusCategory() { const s = document.getElementById('OpportunityPanel_StatusDropdown'); if (!s) return ''; const v = (s.value||'').split(':')[0]; return {'15':'Active','16':'Sold','17':'Inactive'}[v] || ''; }

function getLabelValue(label) {
  for (const el of document.querySelectorAll('[data-i18n*="' + label + '"]')) {
    const td = el.closest('td'); if (!td) continue;
    const next = td.nextElementSibling; if (!next) continue;
    const v = cleanText(getVisibleText(next)); if (v) return v;
  }
  for (const td of document.querySelectorAll('td')) {
    const t = td.textContent?.trim() || '';
    if (t.includes(label) && t.includes(':') && t.length < 100) {
      const next = td.nextElementSibling;
      if (next) { const v = cleanText(getVisibleText(next)); if (v) return v; }
    }
  }
  return '';
}

function getSalesTeam(doc) {
  doc = doc || document;
  const link = doc.getElementById('OpportunityPanel_SalesTeamLink'); if (!link) return [];
  const td = link.closest('td'); if (!td) return [];
  const next = td.nextElementSibling; if (!next) return [];
  const team = [];
  // eLead's salesTeam table sometimes includes a "launch" link or similar
  // UI element after each rep's name. cleanText() collapses whitespace but
  // doesn't strip those words, so they end up concatenated to the name
  // (e.g. "Andrews, Zlaunch"). Defensive trailing-token strip below.
  const stripUiNoise = s => (s || '')
    .replace(/\s*(launch|edit|delete|view|info|click|open|menu)+\s*$/gi, '')
    .trim();
  next.querySelectorAll('tr').forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 2) {
      const n = stripUiNoise(cleanText(cells[0].textContent));
      const r = cleanText(cells[1].textContent).replace(/^-\s*/,'');
      if (n) team.push({name:n,role:r});
    }
  });
  if (!team.length) {
    const t = stripUiNoise(cleanText(getVisibleText(next)));
    if (t) team.push({name:t,role:''});
  }
  return team;
}

// Map an eLead sales-team role string (e.g. "Primary Salesperson",
// "Primary BDC Manager", "Primary Sales Manager", "Primary GoldDigger
// Specialist") to a coarse type:
//   'golddigger' | 'bdc' | 'manager' | 'sales' | 'other'.
//
// Precedence matters because roles overlap and department beats seniority:
//   1. GoldDigger first → equity / data-mining role (eLead "GoldDigger" /
//        Equity tab). This targets existing owners who AREN'T actively in
//        market, so it is NOT active sales — check it before 'specialist'
//        and 'manager' so "GoldDigger Specialist"/"GoldDigger Manager" don't
//        leak into those buckets.
//   2. BDC              → any BDC-department role (incl. "BDC Manager").
//   3. Manager          → Sales/Finance/General/Desk managers, Closers, etc.
//   4. Sales            → Salesperson, Consultant, Specialist, Advisor.
//   5. Fallback         → 'other' so nothing is silently mis-bucketed.
// The raw role string is preserved on each entry, so reclassifying later is
// a one-line change here without needing to re-scrape.
function classifySalesRepType(role) {
  const r = (role || '').toLowerCase();
  if (/gold\s*-?\s*digger|equity|\bmining\b/.test(r)) return 'golddigger';
  if (/\bbdc\b/.test(r)) return 'bdc';
  if (/manager|mgr|closer|director|desk|finance|f&i|f & i/.test(r)) return 'manager';
  if (/salesperson|sales|consultant|specialist|advisor|associate|\brep\b/.test(r)) return 'sales';
  return 'other';
}

// Build the sales_rep[] array from the parsed sales team. Each entry is
// { name, type, role } where `type` is the coarse bucket and `role` is the
// original eLead role string (kept for traceability). This runs ALONGSIDE
// the existing salesTeam[] — it does not replace it.
function getSalesReps(team) {
  const src = Array.isArray(team) ? team : getSalesTeam();
  return src
    .filter(m => m && m.name)
    .map(m => ({
      name: m.name,
      type: classifySalesRepType(m.role),
      role: m.role || '',
    }));
}

// ════════════════════════════════════════════════════════════════
// CALLDRIP → SALES REP ATTRIBUTION
// ────────────────────────────────────────────────────────────────
// Every CallDrip row in the activity history is credited to a person in
// the "Completed By" column, but eLead abbreviates the name there:
//
//   Sales Teams panel :  "Gordon, Jon"      - Primary Salesperson
//                        "Garza, Aurelio"   - Primary BDC Agent
//   Activity history  :  "Gordon, J"  /  "Garza, A"  /  "BLACKLAW, L"
//
// So we normalise both sides to `lastname|firstinitial` and match on that.
// The result is stamped onto every callDrip entry as:
//   type    → 'salesperson' | 'bdc' | 'other'   (the coarse bucket asked for)
//   repType → the finer bucket from classifySalesRepType() (sales / bdc /
//             manager / golddigger / other), kept so a call handled by a
//             manager or an equity rep is still distinguishable later.
// Nothing is dropped: agentName (as printed on the row), the matched sales
// team name, the raw eLead role string and how we decided (typeSource) all
// ride along, so a mis-bucketed call can be re-derived without re-scraping.
// ════════════════════════════════════════════════════════════════

// "Gordon, J" / "GORDON, Jon" / "Jon Gordon" → { last:'gordon', fi:'j' }
function normalizeRepName(raw) {
  const s = cleanText(raw || '')
    .replace(/\s*\(.*?\)\s*/g, ' ')      // drop "(BDC)" style suffixes
    .replace(/[.\u2019']/g, '')
    .trim();
  if (!s) return null;
  let last = '', first = '';
  if (s.includes(',')) {
    const [l, f = ''] = s.split(',');
    last = l; first = f;
  } else {
    // "Jon Gordon" → last token is the surname
    const parts = s.split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    last = parts[parts.length - 1];
    first = parts.length > 1 ? parts[0] : '';
  }
  last = last.trim().toLowerCase().replace(/[^a-z\- ]/g, '');
  first = first.trim().toLowerCase().replace(/[^a-z\- ]/g, '');
  if (!last) return null;
  return { last, fi: first ? first[0] : '', full: s.toLowerCase() };
}

// classifySalesRepType() buckets → the three buckets we stamp on calls.
// Managers / GoldDigger / unmatched all fall to 'other' on purpose: they
// are neither the salesperson nor the BDC agent working the lead.
function repTypeToCallType(repType) {
  if (repType === 'bdc') return 'bdc';
  if (repType === 'sales') return 'salesperson';
  return 'other';
}

// Pre-normalise the sales team once per page so each row match is O(team).
// `priority` ranks the source: 0 = the lead's own Sales Teams panel (most
// authoritative), 1 = a fallback source such as the Audit Trail. A lower
// number always wins, so a fallback can only ever fill a gap — it can
// never override what the panel says about someone.
function buildRepIndex(salesReps, priority) {
  return (salesReps || [])
    .map(r => {
      const n = normalizeRepName(r?.name);
      if (!n) return null;
      const repType = r.type || classifySalesRepType(r.role);
      return {
        key: n.last + '|' + n.fi,
        last: n.last,
        fi: n.fi,
        name: r.name,
        role: r.role || '',
        repType,
        type: repTypeToCallType(repType),
        priority: priority || 0,
        source: r.source || (priority ? 'fallback' : 'sales-team'),
      };
    })
    .filter(Boolean);
}

// Resolve one "Completed By" name against the sales team index.
// Matching is deliberately conservative — we only claim a match when the
// surname is identical AND the first initials agree (or one side has no
// first name at all). Anything ambiguous or unmatched becomes 'other' with
// a typeSource that says why, rather than a confident wrong answer.
function resolveRepType(agentName, repIndex) {
  const base = {
    type: 'other', repType: 'other', agentName: cleanText(agentName || ''),
    matchedRepName: '', role: '', typeSource: 'unmatched',
  };
  const n = normalizeRepName(agentName);
  if (!n) return { ...base, typeSource: 'no-agent' };
  if (!repIndex || !repIndex.length) return { ...base, typeSource: 'no-team' };

  let hits = repIndex.filter(r =>
    r.last === n.last && (!r.fi || !n.fi || r.fi === n.fi));
  if (!hits.length) return base;

  // Keep only the most authoritative source that matched, so an Audit
  // Trail entry can't contradict the Sales Teams panel.
  const best = Math.min(...hits.map(h => h.priority || 0));
  hits = hits.filter(h => (h.priority || 0) === best);

  const types = new Set(hits.map(h => h.type));
  if (types.size > 1) {
    // Same surname + initial on two different teams — refuse to guess.
    return { ...base, typeSource: 'ambiguous',
      matchedRepName: hits.map(h => h.name).join(' | ') };
  }
  const hit = hits[0];
  return {
    type: hit.type,
    repType: hit.repType,
    agentName: base.agentName,
    matchedRepName: hit.name,
    role: hit.role,
    typeSource: hits.length > 1 ? 'surname-multi'
      : (hit.priority ? hit.source : 'matched'),
  };
}

// Pull the person credited with an activity row. eLead puts the display
// name in `td.completedBy` and the unabbreviated pair in that cell's
// title ("Created By: Garza, A\nCompleted By: Garza, A"). We prefer
// "Completed By" — a task can be created by the BDC and completed by the
// salesperson, and the call itself belongs to whoever completed it.
function getRowAgentName(row) {
  if (!row) return '';
  // eLead nests the activity table inside a container <tr> that spans the
  // whole history block, so a naive "table tr" walk hits that wrapper first
  // and it contains EVERY call plus EVERY name. Only leaf rows — one
  // Completed By cell, no nested rows — may claim an attribution; the
  // wrapper resolves to no-agent and its URLs get upgraded when the real
  // row is reached.
  // (Leaf rows legitimately contain small nested tables for the activity
  // icon, so "has a nested <tr>" is not the test — cell ownership is.)
  const cell = [...row.querySelectorAll('td.completedBy, .completedBy')]
    .find(c => c.closest('tr') === row);
  if (!cell) return '';
  const title = cell.getAttribute('title') || '';
  const m = title.match(/Completed\s*By\s*:\s*([^\n\r]+)/i);
  if (m && m[1].trim()) return cleanText(m[1]);
  const c = title.match(/Created\s*By\s*:\s*([^\n\r]+)/i);
  if (c && c[1].trim()) return cleanText(c[1]);
  return cleanText(cell.textContent);
}

// Every calldrip.com/calls/<id> reference inside a chunk of html/text.
function extractCallDripUrls(html) {
  const found = [];
  const re = /https?:\/\/(?:[\w-]+\.)*calldrip\.com\/[^\s"'<>)]+/gi;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    const url = m[0].replace(/[.,;]+$/, '');
    if (!found.includes(url)) found.push(url);
  }
  return found;
}

function callDripIdFromUrl(url) {
  const m = String(url || '').match(/\/calls\/(\d+)/);
  return m ? m[1] : '';
}

function getSalesSteps() {
  const steps = {};
  document.querySelectorAll('[id^="OpportunityPanel_cbSalesStep_"]').forEach(cb => {
    const label = cb.closest('span')?.querySelector('label');
    if (label) steps[label.textContent.trim()] = cb.checked;
  });
  return steps;
}

function getStatusFlag() {
  const flag = document.getElementById('OpportunityPanel_imgStatusFlag'); if (!flag) return null;
  const title = flag.getAttribute('title') || ''; const src = flag.getAttribute('src') || '';
  let color = 'unknown';
  if (src.includes('green')) color='green'; else if (src.includes('red')) color='red';
  else if (src.includes('yellow')) color='yellow'; else if (src.includes('orange')) color='orange';
  const info = { color, raw: title };
  const vm = title.match(/Viewed On:\s*([\d\-\/]+)\s*By:\s*([^F]+)/i);
  if (vm) { info.viewedOn = vm[1].trim(); info.viewedBy = vm[2].trim(); }
  const fm = title.match(/Followed Up On:\s*([\d\-\/]+)\s*By:\s*(.+)/i);
  if (fm) { info.followedUpOn = fm[1].trim(); info.followedUpBy = fm[2].trim(); }
  return info;
}

function scrapeNotes() {
  const notes = [];
  // Previous Opportunity Status Notes rows
  const noteHeader = document.getElementById('OpportunityPanel_PrevOpptyNotesHeaderRow');
  if (noteHeader) {
    let row = noteHeader.nextElementSibling;
    while (row && row.tagName === 'TR') {
      const text = cleanText(row.textContent);
      if (text && text.length > 5 && !text.includes('Previous Opportunity')) notes.push(text);
      row = row.nextElementSibling;
    }
  }
  // Pattern scan
  const bodyText = document.body?.innerText || '';
  const matches = bodyText.matchAll(/[\w][\w\s,]+?\s+Set\s+Opportunity\s+from\s+[^\n]+/gi);
  for (const m of matches) { if (!notes.includes(m[0].trim())) notes.push(m[0].trim()); }
  return notes;
}

function getNoActiveOpptyMessage() {
  const bodyText = document.body?.innerText || '';
  const m = bodyText.match(/([\w\s]+does not have an active opportunity)/i);
  return m ? m[1].trim() : '';
}

function getPreviousOpportunityInfo() {
  const info = {};
  const viewLink = document.getElementById('OpportunityPanel_ViewPrevOpptyLink');
  if (viewLink) { info.hasPreviousOpportunity = true; info.viewPrevLink = viewLink.href || ''; }
  if (document.querySelector('#newOpptyLink, a.newOppty')) info.canCreateNew = true;
  return Object.keys(info).length > 0 ? info : null;
}

function getTabNames() {
  const tabs = [];
  document.querySelectorAll('#tblTabs li').forEach(li => {
    const name = cleanText(li.textContent); if (name) tabs.push({ name, active: li.classList.contains('selected') });
  });
  return tabs;
}

function getAllLabelValuePairs() {
  const pairs = {};
  document.querySelectorAll('a.editCust, a.editOppty, a.edittradein, a.aspNetDisabled').forEach(link => {
    const label = cleanText(link.textContent).replace(/:$/,'');
    if (!label || label.length > 50) return;
    const td = link.closest('td'); if (!td) return;
    const next = td.nextElementSibling; if (!next) return;
    const val = cleanText(getVisibleText(next));
    if (val && val.length < 500) pairs[label] = val;
  });
  document.querySelectorAll('[data-i18n]').forEach(span => {
    const label = cleanText(span.textContent).replace(/:$/,'');
    if (!label || label.length > 50 || label.length < 2) return;
    const td = span.closest('td'); if (!td) return;
    const next = td.nextElementSibling; if (!next) return;
    const val = cleanText(getVisibleText(next));
    if (val && val.length > 0 && val.length < 500 && !pairs[label]) pairs[label] = val;
  });
  document.querySelectorAll('select').forEach(sel => {
    const id = sel.id || ''; if (!id || sel.selectedIndex < 0) return;
    const opt = sel.options[sel.selectedIndex];
    if (opt) pairs['dropdown_' + id.replace(/^.*?_/,'').replace(/([A-Z])/g,' $1').trim()] = opt.textContent.trim();
  });
  return pairs;
}

function cleanText(t) { if (!t) return ''; return t.replace(/\s+/g,' ').replace(/\u00a0/g,' ').replace(/\[email\s*protected\]/gi,'').trim(); }
// Removes relative-age strings eLead bakes into message bubbles and
// activity rows ("2 days ago", "an hour ago", "yesterday"). These change
// every day, which makes an otherwise identical row look brand new to the
// recheck diff. Absolute timestamps are captured separately and kept.
// Tail-anchored on purpose: eLead appends the label at the end, so real
// wording elsewhere ("I bought a car 3 years ago") is never touched.
const REL_AGO_TAIL_RX = new RegExp(
  '(?:' +
    'just\\s+now|moments?\\s+ago' +
    '|(?:about|over|almost|nearly|~)?\\s*' +
      '(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|few|couple(?:\\s+of)?)\\s*' +
      '(?:sec(?:ond)?s?|min(?:ute)?s?|hrs?|hours?|days?|weeks?|months?|years?)\\s+ago' +
  ')\\s*$',
  'i'
);
// Bare labels only when glued with no space to the preceding character.
const REL_LABEL_TAIL_RX = /(?<=\S)(?:yesterday|today)\s*$/i;
function stripRelativeTime(t) {
  if (!t) return '';
  let out = cleanText(String(t));
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = cleanText(out.replace(REL_AGO_TAIL_RX, ''));
    out = cleanText(out.replace(REL_LABEL_TAIL_RX, ''));
    if (out === before) break;
  }
  return out;
}
function getVisibleText(el) {
  if (!el) return ''; let t = '';
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    else if (n.nodeType === Node.ELEMENT_NODE) {
      try { const s = window.getComputedStyle(n); if (s.display==='none'||s.visibility==='hidden') continue; } catch(e){}
      if (['IMG','SCRIPT','STYLE','SVG'].includes(n.tagName)) continue;
      t += getVisibleText(n);
    }
  }
  return t;
}
function splitName(f) { const p = f.trim().split(/[\s,]+/).filter(Boolean); if (f.includes(',')) return {lastName:p[0]||'',firstName:p.slice(1).join(' ')}; return {firstName:p[0]||'',lastName:p.slice(1).join(' ')}; }

// ── Collect all lead links from the active leads / prospect listing page ──
function collectLeadLinksFromPage() {
  const leads = [];
  const seen = new Set();

  // Method 1: Links with lPID + lDID params (OpptyDetails links)
  document.querySelectorAll('a[href*="OpptyDetails"], a[href*="lPID"], a[onclick*="lPID"]').forEach(a => {
    const href = a.href || '';
    const onclick = a.getAttribute('onclick') || '';
    const source = href || onclick;

    const pidMatch = source.match(/lPID=(\d+)/i);
    const didMatch = source.match(/lDID=(\d+)/i);
    if (pidMatch && didMatch) {
      const key = pidMatch[1] + '-' + didMatch[1];
      if (seen.has(key)) return;
      seen.add(key);

      let url = href;
      if (!url || url === '#' || !url.includes('OpptyDetails')) {
        url = gpOpptyUrl(pidMatch[1], didMatch[1]);
      }
      const name = gpBestLeadName(a) || 'Unknown';
      leads.push({ personId: pidMatch[1], dealId: didMatch[1], name, url });
    }
  });

  // Method 2: onclick with goTo or window.open containing OpptyDetails
  document.querySelectorAll('[onclick*="OpptyDetails"]').forEach(el => {
    const onclick = el.getAttribute('onclick') || '';
    const pidMatch = onclick.match(/lPID=(\d+)/i);
    const didMatch = onclick.match(/lDID=(\d+)/i);
    if (pidMatch && didMatch) {
      const key = pidMatch[1] + '-' + didMatch[1];
      if (seen.has(key)) return;
      seen.add(key);
      const url = gpOpptyUrl(pidMatch[1], didMatch[1]);
      const name = (el.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80) || 'Unknown';
      leads.push({ personId: pidMatch[1], dealId: didMatch[1], name, url });
    }
  });

  // Method 3: Table rows with data attributes
  document.querySelectorAll('tr[data-personid], tr[data-pid]').forEach(tr => {
    const pid = tr.getAttribute('data-personid') || tr.getAttribute('data-pid') || '';
    const did = tr.getAttribute('data-dealid') || tr.getAttribute('data-did') || '';
    if (pid && did) {
      const key = pid + '-' + did;
      if (seen.has(key)) return;
      seen.add(key);
      const url = gpOpptyUrl(pid, did);
      const name = (tr.querySelector('td a, td span')?.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80) || 'Unknown';
      leads.push({ personId: pid, dealId: did, name, url });
    }
  });

  console.log('[eLead Scraper] Collected ' + leads.length + ' lead links from page');
  return leads;
}
function isChecked(id) { const el = document.getElementById(id); return el ? el.checked : false; }

// ════════════════════════════════════════════════════════════════
// 5. LEAD PAGE TABS (Contacts, Service, Relationships, etc.)
//    These are NOT separate URLs — clicking <li> swaps the
//    src of <iframe id="tabsTargetFrame"> on the same page.
// ════════════════════════════════════════════════════════════════

const TAB_LABEL_MAP = {
  liContacts: 'Contacts',
  liService: 'Service',
  liRelationships: 'Relationships',
  liAdditionalProfile: 'Ins/Other',
  liLifetimeValue: 'Lifetime Value',
  liVehicles: 'Vehicles',
  liAuditTrail: 'Audit Trail',
  liGoldDigger2: 'Equity',
};

function listLeadPageTabs() {
  const tabs = [];
  const tblTabs = document.getElementById('tblTabs');
  if (!tblTabs) return tabs;
  // All <li> inside the tab strip (some have <a>, some don't — like Vehicles)
  tblTabs.querySelectorAll('li[id^="li"]').forEach(li => {
    const id = li.id || '';
    if (!id) return;
    const span = li.querySelector('span[data-i18n], span');
    const label = TAB_LABEL_MAP[id] || cleanText((span || li).textContent) || id;
    tabs.push({ id, label, selected: li.classList.contains('selected') });
  });
  return tabs;
}

function clickLeadPageTab(tabLiId) {
  const li = document.getElementById(tabLiId);
  if (!li) return false;
  // Some tabs have <a> inside (Contacts, Service, etc.), some don't (Vehicles).
  // Click <a> if present (its z-index handler is bound there), else click <li>.
  const a = li.querySelector('a');
  try { (a || li).click(); return true; }
  catch (e) {
    try { li.click(); return true; } catch (e2) { return false; }
  }
}

function scrapeTabIframe() {
  const iframe = document.getElementById('tabsTargetFrame');
  if (!iframe) return { error: 'tabsTargetFrame not found' };
  let iDoc;
  try { iDoc = iframe.contentDocument || iframe.contentWindow?.document; }
  catch (e) { return { error: 'iframe access denied: ' + e.message }; }
  if (!iDoc || !iDoc.body) return { error: 'iframe document not loaded yet' };

  const result = {
    iframeUrl: iframe.src || '',
    iframeTitle: iDoc.title || '',
    scrapedAt: new Date().toISOString(),
  };

  // Label:value pairs from tables
  const pairs = {};
  iDoc.querySelectorAll('table tr').forEach(row => {
    const cells = row.querySelectorAll('td, th');
    for (let i = 0; i < cells.length - 1; i++) {
      const raw = cells[i].textContent?.trim() || '';
      const m = raw.match(/^([A-Za-z\s\/\-#&().]+?)\s*:\s*$/);
      if (m && m[1].length > 1 && m[1].length < 60) {
        const key = m[1].trim();
        const val = cleanText(cells[i + 1].textContent);
        if (val && val.length < 500 && !pairs[key]) pairs[key] = val;
      }
      const inline = raw.match(/^([A-Za-z\s\/\-#&().]+?)\s*:\s+(.+)/);
      if (inline && inline[1].length < 60 && !pairs[inline[1].trim()]) {
        pairs[inline[1].trim()] = cleanText(inline[2]);
      }
    }
  });
  // Also data-i18n labeled fields
  iDoc.querySelectorAll('[data-i18n]').forEach(span => {
    const raw = span.textContent?.trim() || '';
    const m = raw.match(/^([A-Za-z\s\/\-#&().]+?)\s*:\s*$/);
    if (!m) return;
    const key = m[1].trim();
    if (key.length < 2 || key.length > 50) return;
    const td = span.closest('td');
    if (!td) return;
    const next = td.nextElementSibling;
    if (!next) return;
    const val = cleanText(next.textContent);
    if (val && val.length < 500 && !pairs[key]) pairs[key] = val;
  });
  result.allFieldPairs = pairs;

  // All table rows as raw arrays — useful for list-style tabs
  // (Vehicles, Audit Trail, Service history)
  //
  // HISTORY WINDOW: the Contacts and Service tabs render the customer's
  // entire lifetime, and render each closed opportunity twice (individual
  // rows + one flattened "mega row"). gpRowVerdict drops the mega rows
  // always and the out-of-window activity rows by date. Rows that carry no
  // activity datetime — Vehicles, Lifetime Value, Relationships, the
  // profile field tables — pass through untouched, so no non-history tab is
  // affected by any of this.
  // Opportunity blocks drive the scoping here (rules 1 + 2). The DATE window
  // applies ONLY to ungrouped rows on an activity-history tab (rule 3).
  // Audit Trail is exempt from the date window on purpose: the backend reads
  // its tableRows to recover a deal's sold date from the "Change Opportunity
  // Status … Sold" row (agent.py::_sold_date_from_doc), and that row can
  // legitimately be old. The MEGA-ROW filter applies everywhere.
  //
  // Detection uses textContent (always present); the fullText trim further
  // down uses innerText because it works line by line and only innerText
  // carries line breaks, with a textContent fallback.
  const bodyProse = iDoc.body?.innerText;
  const bodyMarkupText = iDoc.body?.textContent || '';
  const applyDateWindow = gpIsHistoryDoc(bodyMarkupText);
  const plan = gpPlanOpportunities(iDoc);

  const rows = [];
  let droppedOpp = 0, droppedStale = 0, droppedMega = 0, droppedNested = 0;
  iDoc.querySelectorAll('table tr').forEach(row => {
    if (gpIsNestedLayoutRow(row)) { droppedNested++; return; }

    const cells = [...row.querySelectorAll('td')].map(c => cleanText(c.textContent)).filter(Boolean);
    if (cells.length === 0) return;
    const text = cleanText(row.textContent);

    if (gpIsMegaRow(cells, text)) { droppedMega++; return; }

    const scope = gpRowScope(row, plan);
    if (scope === 'drop-opp') { droppedOpp++; return; }
    // 'in-opp' → the whole deal comes through, however old its rows are.
    if (scope === 'ungrouped' && applyDateWindow &&
        gpRowVerdict(cells, text) === 'stale') { droppedStale++; return; }

    rows.push(cells);
  });
  result.tableRows = rows;

  // Provenance: exactly which opportunities were scoped in/out and why, so a
  // stored doc can be audited without re-scraping.
  result.historyScope = {
    currentDealId: plan ? plan.currentDealId : '',
    anchoredOnDealId: plan ? plan.anchoredOnDealId : false,
    priorOppDays: gpPriorOppDays(),
    ungroupedWindowDays: gpHistoryDays(),
    ungroupedWindowApplied: applyDateWindow,
    opportunities: plan ? plan.blocks : [],
    keptRows: rows.length,
    droppedOpportunityRows: droppedOpp,
    droppedStaleUngroupedRows: droppedStale,
    droppedMegaRows: droppedMega,
    droppedNestedLayoutRows: droppedNested,
  };

  // The top completed activity, parsed here where we still have the live DOM.
  // The server already derives `activities[]` from tableRows, but doing it at
  // the source means the window filter can never strip the one row the server
  // needs (it is always the newest, so it is always in-window).
  result.currentActivity = gpTopActivityFromRows(rows);

  // External links (relationships referrals, audit trail user IDs, etc.)
  const links = [];
  iDoc.querySelectorAll('a[href]').forEach(a => {
    const text = cleanText(a.textContent);
    const href = a.href || '';
    if (text && href && !href.startsWith('javascript:')) {
      links.push({ text: text.substring(0, 200), href });
    }
  });
  result.links = links.slice(0, 200);

  // Visible text (capped). On activity-history tabs the raw innerText is the
  // customer's whole lifetime, so window-filter it line by line first. Other
  // tabs — including Audit Trail, whose old "added to the sales team" lines we
  // still need for role resolution — are left exactly as they were.
  const visibleText = (typeof bodyProse === 'string' && bodyProse) ? bodyProse : bodyMarkupText;
  result.fullText = applyDateWindow
    ? cleanText(gpTrimHistoryText(visibleText)).substring(0, 30000)
    : cleanText(visibleText).substring(0, 30000);

  return result;
}

// ════════════════════════════════════════════════════════════════
// 6. TEXT MESSAGES (Messenger chat page)
//    Reached by navigating to the `clientUrl` JS var from the
//    lead page (a JWT-tokenized URL into /rt/MessengerClient/...).
//    Outputs both a structured `messages[]` array and a formatted
//    `conversationTranscript` showing Customer vs Sales lines.
// ════════════════════════════════════════════════════════════════

function scrapeTextMessagesPage() {
  const doc = document;
  const result = {
    scrapedAt: new Date().toISOString(),
    messages: [],
    messageCount: 0,
    conversationTranscript: '',
  };

  const seen = new Set();
  const messages = [];

  const inferDirection = (cls, dataDir, alignment) => {
    const blob = (cls + ' ' + dataDir + ' ' + alignment).toLowerCase();
    // eLead MessengerClient marks bubbles host-originated (sales/dealer)
    // vs customer-originated. Check these explicit markers first.
    if (/host-originated/.test(blob)) return 'outbound';
    if (/customer-originated/.test(blob)) return 'inbound';
    if (/\b(outbound|outgoing|sent|from-me|own|self|right|salesperson|agent|dealer|host|me-message)\b/.test(blob)) return 'outbound';
    if (/\b(inbound|incoming|received|from-them|other|left|customer|client|them-message|consumer)\b/.test(blob)) return 'inbound';
    return 'unknown';
  };

  // Strategy 1: common message-bubble selectors. eLead's own
  // `.convmessage-NNN.message.host-originated|customer-originated`
  // bubbles are matched first so we get clean per-message rows.
  const msgSelectors = [
    '[class*="convmessage-"]',
    '.message.host-originated, .message.customer-originated',
    '[class*="message-row"]',
    '[class*="message-bubble"]',
    '[class*="chat-message"]',
    '[class*="conversation-item"]',
    '[class*="msg-item"]',
    '[data-direction]',
    '[data-message-id]',
    'li[class*="message"]',
    'div[class*="message"]:not([class*="messages-list"]):not([class*="messageBox"]):not([class*="messageInput"])',
  ];
  for (const sel of msgSelectors) {
    try {
      const found = doc.querySelectorAll(sel);
      if (!found.length) continue;
      found.forEach(el => {
        const text = cleanText(el.innerText || el.textContent);
        if (!text || text.length < 2 || text.length > 5000) return;
        if (seen.has(text)) return;
        seen.add(text);

        const cls = (el.className || '').toString().toLowerCase();
        const dataDir = (el.dataset?.direction || '').toLowerCase();
        let alignment = '';
        try {
          const cs = window.getComputedStyle(el);
          alignment = (cs.textAlign || '') + ' ' + (cs.justifyContent || '') + ' ' + (cs.alignSelf || '');
        } catch (e) {}
        const direction = inferDirection(cls, dataDir, alignment);

        // Timestamp — look for nested time/date elements
        let timestamp = '';
        const ts = el.querySelector('time, [class*="time"], [class*="date"], [class*="timestamp"], [datetime]');
        if (ts) timestamp = cleanText(ts.getAttribute('datetime') || ts.textContent).substring(0, 50);

        // Sender name
        let sender = '';
        const senderEl = el.querySelector('[class*="sender"], [class*="author"], [class*="from"]:not([class*="from-me"]):not([class*="from-them"]), [class*="username"], [class*="display-name"]');
        if (senderEl) sender = stripRelativeTime(cleanText(senderEl.textContent)).substring(0, 100);

        // Strip the timestamp/sender out of the text body if they appear inside it
        let body = text;
        if (timestamp && body.includes(timestamp)) body = body.replace(timestamp, '').trim();
        if (sender && body.startsWith(sender)) body = body.substring(sender.length).trim();
        // eLead also renders a RELATIVE age ("2 days ago") inside the bubble.
        // It changes daily, so leaving it in makes an unchanged message look
        // new on every recheck. The real timestamp is captured above.
        body = stripRelativeTime(body);
        if (sender && body.startsWith(sender)) body = body.substring(sender.length).trim();

        messages.push({ text: body, direction, timestamp, sender, rawClass: cls.substring(0, 200) });
      });
      if (messages.length > 0) break;
    } catch (e) {}
  }

  // Strategy 2: fallback — children of any container that looks like a message list
  if (messages.length === 0) {
    const containers = doc.querySelectorAll('[class*="conversation"], [class*="messages-list"], [class*="chat-container"], [class*="message-list"]');
    containers.forEach(container => {
      [...container.children].forEach(el => {
        const text = cleanText(el.innerText || el.textContent);
        if (!text || text.length < 2 || text.length > 5000) return;
        if (seen.has(text)) return;
        seen.add(text);
        const cls = (el.className || '').toString().toLowerCase();
        let alignment = '';
        try {
          const cs = window.getComputedStyle(el);
          alignment = (cs.textAlign || '') + ' ' + (cs.justifyContent || '') + ' ' + (cs.alignSelf || '');
        } catch (e) {}
        messages.push({ text: stripRelativeTime(text), direction: inferDirection(cls, '', alignment), timestamp: '', sender: '', rawClass: cls.substring(0, 200) });
      });
    });
  }

  result.messages = messages;
  result.messageCount = messages.length;

  // Build readable transcript
  result.conversationTranscript = messages.map(m => {
    const who = m.direction === 'outbound' ? 'Sales' : (m.direction === 'inbound' ? 'Customer' : 'Unknown');
    const when = m.timestamp ? '[' + m.timestamp + '] ' : '';
    const sender = m.sender ? ' (' + m.sender + ')' : '';
    return when + who + sender + ': ' + m.text;
  }).join('\n');

  // Full text fallback
  result.fullText = cleanText(doc.body?.innerText || '').substring(0, 50000);

  return result;
}

// ════════════════════════════════════════════════════════════════
//  Click-to-call helper for the sidepanel "Call" button
// ════════════════════════════════════════════════════════════════
//
// When the rep clicks the "Call" button on a salesperson card, the
// sidepanel asks the background worker to open the lead's eLead URL
// in a new tab and flag it. After that tab loads, content.js asks
// the background "should I fire a call?" — if yes, we synthesize a
// click on eLead's phone-icon element.
//
// eLead's phone control isn't a single stable selector (it varies
// per version + skin), so we try a list of plausible targets in
// priority order:
//   1. The element with id="phoneNumber" — present on the lead
//      detail header in v45.
//   2. Any anchor with an href starting with `tel:` — works as a
//      universal fallback.
//   3. Any element with class "phone" or "phoneClick" — older skins.
// If none match, we log + give up silently (the rep still sees the
// lead and can click the phone themselves).
function _gpTryClickToCall() {
  const log = (m) => console.log('[GP click-to-call]', m);

  // Wait up to 8 seconds for the lead detail UI to render — eLead's
  // SPA loads slowly and the phone element isn't there at load time.
  const start = Date.now();
  const tryOnce = () => {
    const selectors = [
      '#phoneNumber',
      'a[href^="tel:"]',
      '.phoneClick',
      'a.phone',
      '[onclick*="phoneClick"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        try {
          el.click();
          log('clicked ' + sel);
          return true;
        } catch (e) {
          log('click failed on ' + sel + ': ' + e.message);
        }
      }
    }
    return false;
  };

  if (tryOnce()) return;

  const interval = setInterval(() => {
    if (tryOnce() || Date.now() - start > 8000) {
      clearInterval(interval);
      if (Date.now() - start >= 8000) {
        log('timeout — no phone element found in 8s');
      }
    }
  }, 250);
}

// Page-load handshake: ask the background whether this tab was
// opened with the call flag. We do this after DOMContentLoaded so
// the phone element has a fighting chance of being in the DOM by
// the time _gpTryClickToCall scans.
function _gpAskBackgroundForCall() {
  try {
    chrome.runtime.sendMessage(
      { type: 'GP_CONSUME_CALL_PENDING' },
      (resp) => {
        if (chrome.runtime.lastError) return;  // background not listening
        if (resp && resp.shouldCall) _gpTryClickToCall();
      }
    );
  } catch (e) { /* ignore */ }
}

// Only run on lead-detail pages — no point asking on every eLead URL
if (/OpptyDetails/i.test(window.location.pathname)) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _gpAskBackgroundForCall);
  } else {
    _gpAskBackgroundForCall();
  }
}

} // ─── end injection-guard else-block
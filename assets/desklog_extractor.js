// desklog_extractor.js — Phase 1 + Phase 2 helpers, executed via
// chrome.scripting.executeScript in the desklog report tab.
//
// Two functions intended for `func:` injection (not as a content
// script). They run in the page's isolated world but with access to
// the DOM.
//
//   extractDesklogStats()  → { period, dept, generatedAt, headers, reps, total, totalDrilldownUrls }
//   extractDrilldownLeadUrls() → [{ name, lPID, lDID, url }, ...]
//
// Both are pure DOM reads — no network, no state. The background
// script handles persistence + orchestration.

/**
 * Parse the per-rep stats table on the Desklog Statistics page.
 *
 * Page layout we rely on:
 *   - The stats table is the second <table class="gridview">
 *     (first is the criteria summary). We pick by header content
 *     instead of position to survive eLead reordering.
 *   - Header row contains "Primary Rep" as the first <th>.
 *   - Each data <tr> has <td>Rep name</td> followed by ~22 numeric
 *     <td>s. Cells with the popuplink class are clickable drilldowns
 *     containing a single <a href="...customReport.aspx?id=1987
 *     &Column=X&User=Y..."> child.
 *   - The Total row has class "footerStyle" (or similar) and
 *     User=-99 in its drilldown URLs.
 *
 * Output schema lives on the server side too (config.COL_DAILY_ACTIVITY).
 * Keep field names in sync.
 */
function extractDesklogStats() {
  // ── Find the right table ──────────────────────────────────
  // eLead's grid has id="gvReport" — target it directly. We fall back
  // to header-based search only if the id is missing (rare; happens
  // if eLead skins their grid differently). The outer wrapper table
  // ALSO contains a <th>Primary Rep</th> nested inside it, so we
  // can't use that header alone — must use the id.
  let statsTable = document.getElementById('gvReport');
  if (!statsTable) {
    // Fallback: find the deepest table whose direct <thead>/first <tr>
    // contains "Primary Rep" as a <th>.
    const tables = Array.from(document.querySelectorAll('table'));
    for (const t of tables) {
      const ths = Array.from(t.querySelectorAll(':scope > tbody > tr > th, :scope > tr > th'));
      if (ths.some(th => th.textContent.trim() === 'Primary Rep')) {
        statsTable = t;
        break;
      }
    }
  }
  if (!statsTable) {
    return { error: 'stats_table_not_found', tablesSeen: document.querySelectorAll('table').length };
  }

  // ── Headers ───────────────────────────────────────────────
  // gvReport's first <tr> holds the <th> column headers. Scope to
  // direct descendants of this specific table — don't pick up <th>
  // from outer wrapper tables.
  const firstRow = statsTable.querySelector('tr');
  const headerCells = firstRow
    ? Array.from(firstRow.querySelectorAll('th'))
    : [];
  const headers = headerCells
    .map(th => (th.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // ── Period + generated-at + dealership name + department ──
  // These live in a wrapper element OUTSIDE the stats table —
  // typically in a header div. Grab them by regex from the page
  // body text. `innerText` is the rendered text (preferred for
  // collapsing whitespace, available in real browser tabs), but
  // jsdom test environments expose only `textContent`, so fall back.
  const pageText = (document.body.innerText || document.body.textContent || '')
    .replace(/[ \t]+/g, ' ');
  const periodMatch = pageText.match(
    /Report Period:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i
  );
  const genMatch = pageText.match(/Generated:\s*([0-9\/]+\s+[0-9:]+\s*[AP]M)/i);
  const deptMatch = pageText.match(/Department\s*[-—]\s*([^\n\r]+?)(?:\s*\n|\s{3,}|$)/i);

  // Dealership name is the line above "Generated:". Normalize line
  // breaks and find a contextually-positioned non-empty line.
  let dealership = '';
  const cleanLines = pageText
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (let i = 0; i < cleanLines.length; i++) {
    if (cleanLines[i].startsWith('Generated:') && i > 0) {
      dealership = cleanLines[i - 1];
      break;
    }
  }

  // ── Walk data rows ────────────────────────────────────────
  // We iterate every <tr> except the first (header), classifying
  // each as rep / total / skip based on cell count + first-cell text.
  // The "Total" row is identified by its first cell containing the
  // literal text "Total" — eLead doesn't put it in a <tfoot>.
  const rows = Array.from(statsTable.querySelectorAll('tr'));
  const reps = [];
  let total = null;
  const totalDrilldownUrls = []; // collected ONLY from the Total row

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length < 5) continue; // skip headers + sparse rows
    // First cell may wrap text in <b> for the Total row (e.g.
    // "<td><b>Total</b></td>") so use textContent and normalize.
    const firstText = (cells[0].textContent || '').replace(/\s+/g, ' ').trim();
    if (!firstText) continue;

    // Build a map of header → cell info { value, drilldownUrl }
    const cellData = {};
    for (let i = 0; i < cells.length && i < headers.length; i++) {
      const td = cells[i];
      const text = (td.textContent || '').replace(/\s+/g, ' ').trim();
      // Drilldown link, if any. eLead's clickable totals are <td
      // class="popuplink"> containing a single <a>. The href looks
      // like:
      //   .../reports/600,800%7C?id=1987&Column=Sold&User=-99...
      // The leading "600,800|" is a popup window-size spec that
      // eLead's frontend JS parses to open the link in a window of
      // those dimensions, *then* navigates to customReport.aspx
      // with the same query string. Programmatic navigation skips
      // that JS interception and eLead rejects the literal
      // "600,800|" path as an invalid path (redirects to login),
      // so we rewrite the href to point at customReport.aspx
      // directly.
      const a = td.querySelector('a[href*="Column="]');
      let drilldown = a ? a.href : null;
      if (drilldown) {
        drilldown = drilldown.replace(
          /\/reports\/[^/?]*\?/i,
          '/reports/customReport.aspx?'
        );
      }
      cellData[headers[i]] = { value: text, drilldown };
    }

    const isTotal = /^total$/i.test(firstText);
    if (isTotal) {
      total = cellData;
      // Collect the 16 drilldown URLs from the Total row in column order.
      // Order matters: ?Column={Showroom,Phone,Internet,Campaign,Visits,
      // NewVisits,UsedVisits,BeBacks,ApptDue,ApptShown,ApptSold,Sold,
      // Demo,TO,WriteUp,Appraisal}. We yield in the order headers
      // appear so the caller can match by index OR by column name.
      for (let i = 0; i < headers.length; i++) {
        const info = cellData[headers[i]];
        if (info && info.drilldown) {
          totalDrilldownUrls.push({
            column: extractColumnParam(info.drilldown),
            header: headers[i],
            url: info.drilldown,
            value: info.value,
          });
        }
      }
    } else {
      // Rep row
      reps.push({ rep: firstText, cells: cellData });
    }
  }

  return {
    dealership,
    department: deptMatch ? deptMatch[1].trim() : '',
    generatedAt: genMatch ? genMatch[1].trim() : '',
    period: periodMatch
      ? { start: periodMatch[1], end: periodMatch[2] }
      : null,
    headers,
    reps,
    total,
    totalDrilldownUrls,
    pageUrl: location.href,
  };

  // Helper — pull ?Column= value out of a drilldown URL.
  function extractColumnParam(url) {
    const m = url.match(/[?&]Column=([^&]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }
}


/**
 * On a drilldown page (e.g. ?Column=Sold), collect every lead URL
 * from the customer-list table.
 *
 * Page layout:
 *   - Same `gridview` table convention.
 *   - The first column is row number, the second is "Prospect" — a
 *     hyperlink to OpptyDetails.aspx?lPID=X&lDID=Y. Some columns
 *     also wrap their numeric values in <a> tags, so we filter to
 *     anchors whose href explicitly contains OpptyDetails or lPID+lDID.
 *
 * Returns the list of unique lead URLs found on this page.
 */
function extractDrilldownLeadUrls() {
  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="OpptyDetails"], a[href*="lPID"]');
  for (const a of anchors) {
    const href = a.href || '';
    const pidM = href.match(/[?&]lPID=(\d+)/i);
    const didM = href.match(/[?&]lDID=(\d+)/i);
    if (!pidM || !didM) continue;
    const key = pidM[1] + '_' + didM[1];
    if (seen.has(key)) continue;
    seen.add(key);

    // ── Per-row sold status (co-buyer detection) ──────────────
    // The Sold drilldown puts a status cell in the SAME <tr> as the
    // Prospect link. eLead marks the second credited name on a deal
    // with a "CoBuyer -" prefix, and stashes the DMS deal number in the
    // cell's title/alt + a SoldHistory id in its onclick, e.g.:
    //   <td onclick="doSoldHistory(19517935);" title=" DMS ID - 74760"
    //       ...>CoBuyer - CRM Sold</td>
    // We surface all three so the reconciliation can (a) skip co-buyers
    // outright and (b) collapse a primary + co-buyer that share a DMS ID
    // even when their lDIDs differ. Best-effort: blanks if not found.
    let soldStatus = '';
    let isCoBuyer = false;
    let dmsId = '';
    let soldHistoryId = '';
    try {
      const row = a.closest('tr');
      if (row) {
        // Prefer the doSoldHistory cell; fall back to any cell whose text
        // reads like a sold status.
        let statusCell = row.querySelector('td[onclick*="doSoldHistory"], td[onclick*="doSoldhistory"]');
        if (!statusCell) {
          statusCell = Array.from(row.querySelectorAll('td')).find(td =>
            /\b(CRM|DMS|Spot|Delivered|Wholesale)\s*Sold\b/i.test(td.textContent || '') ||
            /co\s*-?\s*buyer/i.test(td.textContent || '')
          );
        }
        if (statusCell) {
          soldStatus = (statusCell.textContent || '').replace(/\s+/g, ' ').trim();
          isCoBuyer = /(^|\b)co\s*-?\s*buyer\b/i.test(soldStatus);
          const oc = statusCell.getAttribute('onclick') || '';
          const shM = oc.match(/doSoldHistory\s*\(\s*(\d+)\s*\)/i);
          if (shM) soldHistoryId = shM[1];
          const tip = statusCell.getAttribute('title') || statusCell.getAttribute('alt') || '';
          const dmsM = tip.match(/DMS\s*ID\s*-\s*(\d+)/i);
          if (dmsM) dmsId = dmsM[1];
        }
      }
    } catch (e) { /* best-effort — leave the fields blank */ }

    // Canonicalize to the same URL shape the existing lead scraper
    // uses, so downstream content.js logic doesn't see two variants
    // for the same deal.
    // Host-agnostic: build against the origin actually serving the CRM
    // (window.__gpCrmOrigin from config, else location.origin), falling back
    // to the legacy host only if neither is readable. content.js exposes
    // gpOpptyUrl when both assets are injected; this file must also work
    // standalone, so the fallback is inlined rather than assumed.
    const canonOrigin = (function () {
      try { if (window.__gpCrmOrigin) return String(window.__gpCrmOrigin).replace(/\/+$/, ''); } catch (e) {}
      try {
        if (location && location.origin &&
            /(?:^|\.)(?:eleadcrm\.com|connectcdk\.com)$/i.test(location.hostname)) {
          return location.origin;
        }
      } catch (e) {}
      return 'https://www.eleadcrm.com';
    })();
    const canon =
      canonOrigin + '/evo2/fresh/elead-v45/elead_track/NewProspects/' +
      'OpptyDetails.aspx?lPID=' + pidM[1] +
      '&lDID=' + didM[1] +
      '&loc=DeskLogDLL&R=NO&LICID=';
    out.push({
      personId: pidM[1],
      dealId: didM[1],
      name: (a.textContent || 'Unknown').replace(/\s+/g, ' ').trim().substring(0, 80),
      url: canon,
      soldStatus,     // '' on non-sold drilldowns
      isCoBuyer,      // true when the sold status is "CoBuyer - …"
      dmsId,          // shared across a primary + its co-buyer(s)
      soldHistoryId,  // eLead SoldHistory record id, if present
    });
  }
  return { leads: out, pageUrl: location.href };
}

/**
 * Parse the "Dealership Lead Source Stats" report (customReport.aspx?id=1829).
 *
 * This is the NEW-leads report (Internet / Phone / Campaign / Showroom ups
 * broken out by lead source). Table layout differs from the desklog stats
 * grid: the first two columns are "Up Type" and "Source" (text), followed
 * by numeric columns each of which is a clickable drilldown:
 *
 *   Up Type | Source | Good Leads | Bad Leads | Duplicate Leads | Net Leads |
 *   Appts Due | Appts Shown | Sold | Closing % | Total Gross | Avg Gross |
 *   Lead Cost | Cost/Sold
 *
 * Rows come in three flavours, distinguished by the text of the first two
 * cells:
 *   - data rows    → real (UpType, Source) pair
 *   - subtotal rows→ Source cell == "Subtotal" (per up-type rollup)
 *   - total row    → Source cell == "Total"  (first cell "All Types")
 *
 * The drilldown anchors look like:
 *   <a href="0,0|?id=1836&run=yes&UpType=-1&Source=-1&NewUsed=NULL&Column=4
 *            &startdate=5/29/2026&enddate=5/29/2026&eleadDarkmode=false">18</a>
 * Same "WxH|" popup-size prefix the desklog uses — we rewrite it to point at
 * customReport.aspx directly (programmatic nav skips eLead's popup JS).
 *
 * We collect drilldown URLs from the TOTAL row only (it aggregates every
 * source), in column order, so the caller can walk them to find lead URLs.
 */
function extractLeadSourceStats() {
  let statsTable = document.getElementById('gvReport');
  if (!statsTable) {
    const tables = Array.from(document.querySelectorAll('table'));
    for (const t of tables) {
      const ths = Array.from(t.querySelectorAll(':scope > tbody > tr > th, :scope > tr > th'));
      if (ths.some(th => /up\s*type/i.test(th.textContent) ) &&
          ths.some(th => /source/i.test(th.textContent))) {
        statsTable = t;
        break;
      }
    }
  }
  if (!statsTable) {
    return { error: 'leadsource_table_not_found', tablesSeen: document.querySelectorAll('table').length };
  }

  // ── Headers ──
  const firstRow = statsTable.querySelector('tr');
  const headerCells = firstRow ? Array.from(firstRow.querySelectorAll('th')) : [];
  const headers = headerCells
    .map(th => (th.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // ── Page-level metadata (report name, dealership, generated, period) ──
  const pageText = (document.body.innerText || document.body.textContent || '')
    .replace(/[ \t]+/g, ' ');
  const reportName = (document.getElementById('lblHeaderReportName')?.textContent || '').trim();
  const dealership = (document.getElementById('lblHeaderCompanyName')?.textContent || '').trim();
  const generatedRaw = (document.getElementById('lblHeaderRunDate')?.textContent || '').trim();
  const genMatch = generatedRaw.match(/Generated:\s*(.+)$/i);
  const periodMatch = pageText.match(
    /Report Period:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i
  );

  function rewriteDrilldown(href) {
    if (!href) return null;
    return href.replace(/\/reports\/[^/?]*\?/i, '/reports/customReport.aspx?');
  }
  function columnParam(url) {
    const m = url.match(/[?&]Column=([^&]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }

  const rows = Array.from(statsTable.querySelectorAll('tr'));
  const dataRows = [];
  let total = null;
  const totalDrilldownUrls = [];

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length < 3) continue; // header / spacer rows

    const upType = (cells[0]?.textContent || '').replace(/\s+/g, ' ').trim();
    const source = (cells[1]?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!upType && !source) continue;

    const isTotal = /^total$/i.test(source) || /^all types$/i.test(upType);
    const isSubtotal = /^subtotal$/i.test(source);

    const cellData = {};
    for (let i = 0; i < cells.length && i < headers.length; i++) {
      const td = cells[i];
      const text = (td.textContent || '').replace(/\s+/g, ' ').trim();
      const a = td.querySelector('a[href*="Column="]');
      const drilldown = a ? rewriteDrilldown(a.href) : null;
      cellData[headers[i]] = { value: text, drilldown };
    }

    const entry = { upType, source, isSubtotal, isTotal, cells: cellData };

    if (isTotal) {
      total = entry;
      for (let i = 0; i < headers.length; i++) {
        const info = cellData[headers[i]];
        if (info && info.drilldown) {
          totalDrilldownUrls.push({
            column: columnParam(info.drilldown),
            header: headers[i],
            url: info.drilldown,
            value: info.value,
          });
        }
      }
    } else {
      dataRows.push(entry);
    }
  }

  return {
    reportName,
    dealership,
    generatedAt: genMatch ? genMatch[1].trim() : generatedRaw,
    period: periodMatch ? { start: periodMatch[1], end: periodMatch[2] } : null,
    headers,
    rows: dataRows,
    total,
    totalDrilldownUrls,
    pageUrl: location.href,
  };
}
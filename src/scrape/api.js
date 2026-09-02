// ---------------------------------------------------------------------------
// src/scrape/api.js — talk to the two Game Plan backends from Node.
//
// The extension used auth.js (gpAuth.authedFetch) to reach:
//   GAMEPLAN_API — FastAPI: login, refresh, agent scrape-done, recheck queue
//   SCRAPER_API  — Express: receives scraped leads, daily URLs, reports
//
// We reproduce that here with Node's global fetch (Node ≥18). Each store runs
// as its own scraper account, so we hold a per-account token set and pass an
// ApiClient instance down through the pipeline instead of a global gpAuth.
// ---------------------------------------------------------------------------
import { GAMEPLAN_API, SCRAPER_API, QUEUE_MODE } from "../config.js";
import { enqueueWrite } from "../store/queue.js";
import { publishWrite } from "../store/jobClient.js";

const DEFAULT_TIMEOUT = 60000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: opts.signal || ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function serverBase() {
  return SCRAPER_API.replace(/\/api\/.*$/, "").replace(/\/$/, "");
}

export class ApiClient {
  constructor({ accessToken, refreshToken } = {}) {
    this.accessToken = accessToken || null;
    this.refreshToken = refreshToken || null;
    this.user = null;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  // Log the scraper account into the FastAPI backend and keep its tokens. This
  // is the SAME login the extension performed (email = the gameplan account's
  // email, NOT the CRM email). Returns the user object.
  static async login(email, password) {
    const resp = await fetchWithTimeout(`${GAMEPLAN_API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: "Login failed" }));
      throw new Error(err.detail || "Login failed");
    }
    const data = await resp.json();
    if (!data.user || !data.user.store_id || !data.user.corporate_id) {
      throw new Error("Account not linked to a store — cannot scrape.");
    }
    const client = new ApiClient({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    });
    client.user = data.user;
    return client;
  }

  // Build a client from a token we minted ourselves (see gpAuth.mintAccessToken).
  // There is no refresh token in this path — the token is long-lived enough to
  // outlast a single store's run, and the runner re-mints per run.
  static fromToken(accessToken, user = null, gameplanToken = null) {
    const client = new ApiClient({ accessToken });
    client.user = user;
    // Token for GAMEPLAN_API (FastAPI). It must NOT carry an aud claim — see
    // gpAuth.mintAccessToken. Falls back to the scraper token when absent so
    // existing callers keep working.
    client.gameplanToken = gameplanToken || null;
    return client;
  }

  async _refresh() {
    if (!this.refreshToken) return null;
    try {
      const resp = await fetchWithTimeout(`${GAMEPLAN_API}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: this.refreshToken }),
      }, 20000);
      if (!resp.ok) return null;
      const data = await resp.json();
      this.accessToken = data.access_token;
      return this.accessToken;
    } catch {
      return null;
    }
  }

  async authedFetch(url, opts = {}) {
    const { timeoutMs, ...rest } = opts;
    // GAMEPLAN_API and SCRAPER_API verify tokens differently, so route each
    // request to the token that host will actually accept.
    const isGameplan = String(url).startsWith(GAMEPLAN_API);
    const token = isGameplan && this.gameplanToken ? this.gameplanToken : this.accessToken;
    const build = (tok) => ({
      ...rest,
      headers: {
        ...(rest.headers || {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
    });
    let resp = await fetchWithTimeout(url, build(token), timeoutMs);
    if (resp.status === 401) {
      const tok = await this._refresh();
      if (tok) resp = await fetchWithTimeout(url, build(tok), timeoutMs);
    }
    return resp;
  }

  // ── JSON helpers on the scraper (Express) server ───────────────────────────
  async postJson(path, body, timeoutMs = 180000) {
    const url = serverBase() + path;
    const resp = await this.authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DevTunnels-Anonymous": "true" },
      body: JSON.stringify(body),
      timeoutMs,
    });
    const text = await resp.text();
    if (text.includes("<!DOCTYPE") || text.includes("<html")) {
      throw new Error("Server returned HTML (auth?)");
    }
    if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + text.substring(0, 200));
    return JSON.parse(text);
  }

  async getJson(path, timeoutMs = 60000) {
    const url = serverBase() + path;
    const resp = await this.authedFetch(url, {
      headers: { "X-DevTunnels-Anonymous": "true" },
      timeoutMs,
    });
    const text = await resp.text();
    if (text.includes("<!DOCTYPE") || text.includes("<html")) {
      throw new Error("Server returned HTML");
    }
    if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + text.substring(0, 200));
    return JSON.parse(text);
  }

  // Send a scraped lead (leadInfo + mainData/subPages/allUrls) to the server.
  // Mirrors background.js::sendToServer, including retries.
  async sendLead(leadInfo, combinedData, source = "daily-scrape", retries = 3) {
    // A lead with no personId can never be stored: the Mongoose schema marks
    // personId required, so the API rejects it with a validation error. This
    // happens when a lead page fails to load at all (deleted/merged in eLead) —
    // the scrape returns a shell with a name and nothing else.
    //
    // Without this guard each shell is retried 3x AND re-queued by the recheck
    // pass, and with 5 workers looping that can consume the agent's entire
    // 40-minute budget. A run that never finishes never calls markScrapeDone,
    // so no schedule run is created and the whole night is lost to a handful of
    // dead leads. Drop them here instead.
    const personId = leadInfo?.personId ?? combinedData?.mainData?.personId;
    if (!personId || String(personId).trim() === "") {
      return { success: false, skipped: "no-personId", dealId: leadInfo?.dealId };
    }

    // Agent mode (Project 2): publish to Redis and return. The agent has no
    // database access at all — the Python writer persists this. jobContext is
    // set by agent.js; when it is absent we are running standalone and fall
    // through to the original direct POST.
    if (this.jobContext) {
      await publishWrite({
        jobId: this.jobContext.jobId,
        storeId: this.jobContext.storeId,
        corporateId: this.jobContext.corporateId,
        path: "/api/process-lead",
        body: { leadInfo, ...combinedData, source },
      });
      return { success: true, queued: true };
    }

    if (QUEUE_MODE === "redis") {
      const queued = await enqueueWrite({
        path: "/api/process-lead",
        body: { leadInfo, ...combinedData, source },
        storeId: this.user?.store_id,
        corporateId: this.user?.corporate_id,
        name: this.user?.name,
      });
      if (queued) return { success: true, queued: true };
    }

    const url = serverBase() + "/api/process-lead";
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 2000 * attempt));
        const resp = await this.authedFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DevTunnels-Anonymous": "true" },
          body: JSON.stringify({ leadInfo, ...combinedData, source }),
        });
        const text = await resp.text();
        if (text.includes("<!DOCTYPE") || text.includes("<html")) return false;
        if (!resp.ok) { if (attempt < retries) continue; return false; }
        const json = JSON.parse(text);
        if (json.success) return json;
        if (attempt < retries) continue;
        return false;
      } catch {
        if (attempt < retries) continue;
        return false;
      }
    }
    return false;
  }

  // ── FastAPI (gameplan) endpoints the pipeline uses ─────────────────────────
  async pendingRechecks(limit = 500) {
    const resp = await this.authedFetch(
      `${GAMEPLAN_API}/api/scraper/pending-rechecks?limit=${limit}`,
      { timeoutMs: 45000 },
    );
    if (!resp.ok) return [];
    const data = await resp.json().catch(() => null);
    if (!data) return [];
    return data.items || [];
  }

  async markScrapeDone() {
    const resp = await this.authedFetch(`${GAMEPLAN_API}/api/agent/scrape-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (resp.ok) return { success: true, data: await resp.json().catch(() => ({})) };
    const err = await resp.json().catch(() => ({ detail: "Unknown" }));
    return { success: false, error: err.detail || `HTTP ${resp.status}` };
  }

  // Flush staging → leads for this store (the 23:30 job hits this per store).
  async flushStaging() {
    return this.postJson("/api/flush-staging", {});
  }

  // Convenience wrappers matching desklog_pipeline's endpoint calls.
  clearDailyUrls() { return this.postJson("/api/clear-daily-urls", {}); }
  saveDailyUrls(body) { return this.postJson("/api/save-daily-urls", body); }
  dailyUrlsPending(isoDate) { return this.getJson(`/api/daily-urls?date=${isoDate}&pending=true`); }
  processDailyActivity(body) { return this.postJson("/api/process-daily-activity", body); }
  saveShowroomReport(body) { return this.postJson("/api/save-showroom-report", body); }
  saveStoreVisits(body) { return this.postJson("/api/save-store-visits", body); }
  storeVisits() { return this.getJson("/api/store-visits"); }
  markStoreVisit(id, body) { return this.postJson(`/api/store-visit/${encodeURIComponent(id)}/mark`, body); }
  flowConfig() { return this.getJson("/api/flow-config"); }
  soldScoredIds(sinceIso) { return this.getJson(`/api/sold-scored-ids?since=${sinceIso}`); }
  scrapedToday(source) {
    return this.getJson("/api/scraped-today" + (source ? `?source=${encodeURIComponent(source)}` : ""));
  }
  leadPages(personId, dealId) { return this.getJson(`/api/scraper/lead-pages/${personId}/${dealId}`); }
}
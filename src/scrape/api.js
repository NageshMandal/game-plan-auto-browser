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
import { GAMEPLAN_API, SCRAPER_API } from "../config.js";

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
  static fromToken(accessToken, user = null) {
    const client = new ApiClient({ accessToken });
    client.user = user;
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
    const build = (tok) => ({
      ...rest,
      headers: {
        ...(rest.headers || {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
    });
    let resp = await fetchWithTimeout(url, build(this.accessToken), timeoutMs);
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

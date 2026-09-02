#!/usr/bin/env node
// ---------------------------------------------------------------------------
// agent.js — Project 2 entry point. Runs ONE store, talks ONLY to Redis.
//
// This is what the ephemeral EC2 instance runs. It has no Mongo driver, no
// database URI and no Fernet key: the dispatcher (Project 3) already resolved
// the credentials, proxy and cookies and put them in the job payload.
//
//   JOB_ID=<id> REDIS_URL=rediss://… node agent.js
//
// Exit codes (read by the user-data script / orchestrator):
//   0 = scraped successfully
//   2 = nothing to do (job missing/expired, or no credentials in the job)
//   1 = failed
// ---------------------------------------------------------------------------
import "dotenv/config";
import { openBrowser } from "./src/browser.js";
import { enterCrm } from "./src/scrape/crmLogin.js";
import { runStorePipeline } from "./src/scrape/pipeline.js";
import { mintAccessToken } from "./src/scrape/gpAuth.js";
import { ApiClient } from "./src/scrape/api.js";
import { sleep } from "./src/scrape/inject.js";
import {
  claimJob, publishSession, publishEvent, closeRedis,
} from "./src/store/jobClient.js";
import { CRM_HOST } from "./src/config.js";

const ts = () => new Date().toISOString();
const log = (m) => console.log(`${ts()} ${m}`);

// Same block-detection heuristic as runStore: only rotate the proxy for
// connection/challenge failures, not for bad credentials.
function looksLikeProxyBlock(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  return /timeout|net::|err_|navigation|blocked|403|429|challenge|access denied|tunnel|proxy/.test(m);
}

// Collect the browser's cookies so the writer can persist them. Mirrors the
// filtering in scrape/session.js — identity cookies only, no stale CRM session.
const JUNK_NAME = /^(WalkMeStorage|_ga|_gid|_gat|_hj|AMP_|QSI_|_fbp|_uet|__utm|optimizely|mp_|intercom-)/i;
const JUNK_DOMAIN = /(walkme\.com|hotjar\.com|google-analytics\.com|doubleclick\.net|qualtrics\.com|amplitude\.com|segment\.(io|com))$/i;

async function collectCookies(page) {
  const client = await page.createCDPSession();
  try {
    await client.send("Network.enable").catch(() => {});
    const { cookies = [] } = await client.send("Network.getAllCookies");
    const now = Math.floor(Date.now() / 1000);
    return cookies.filter((c) => {
      const name = String(c.name || "");
      const domain = String(c.domain || "").replace(/^\./, "");
      if (JUNK_NAME.test(name) || JUNK_DOMAIN.test(domain)) return false;
      if (typeof c.expires === "number" && c.expires > 0 && c.expires < now) return false;
      if (domain.toLowerCase().includes(CRM_HOST.toLowerCase())) return false;
      return true;
    });
  } finally {
    await client.detach().catch(() => {});
  }
}

// Restore cookies handed to us in the job (already filtered by the writer).
async function injectCookies(page, cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return false;
  const client = await page.createCDPSession();
  try {
    await client.send("Network.enable").catch(() => {});
    await client.send("Network.setCookies", { cookies });
    return true;
  } catch {
    return false;
  } finally {
    await client.detach().catch(() => {});
  }
}

async function main() {
  const jobId = process.env.JOB_ID;
  if (!jobId) { log("JOB_ID is not set — nothing to do"); return 2; }

  log(`Claiming job ${jobId}`);
  const job = await claimJob(jobId);
  if (!job) { log(`Job ${jobId} not found or expired`); return 2; }

  const storeId = job.store_id;
  const tag = job.name || storeId;
  log(`Job claimed: ${tag} (${storeId})`);

  if (!job.crm_username || !job.crm_password) {
    log("Job carries no CRM credentials — nothing to do");
    await publishEvent({ jobId, storeId, event: "failed", detail: { reason: "no-credentials" } });
    return 2;
  }

  await publishEvent({ jobId, storeId, event: "started", detail: { at: ts() } });

  const creds = { username: job.crm_username, password: job.crm_password };

  // TWO tokens, because the backends disagree about the same claims:
  //
  //   server.js (SCRAPER_API) calls jwt.verify(..., { issuer, audience }) and
  //     REJECTS a token that lacks iss/aud.
  //   FastAPI (GAMEPLAN_API) calls jwt.decode(...) with NO audience param, and
  //     PyJWT raises InvalidAudienceError if the token HAS an aud claim.
  //
  // One token cannot satisfy both — with a single aud-bearing token you get
  // "mark-done failed: Invalid or expired token" and pendingRechecks silently
  // returns [] ("No recheck leads"). api.js routes each request to the right
  // token by host.
  const identity = {
    _id: storeId, role: "scraper",
    store_id: storeId, corporate_id: job.corporate_id, name: job.name,
  };
  const api = ApiClient.fromToken(
    mintAccessToken(identity, true),   // SCRAPER_API — with iss/aud
    { store_id: storeId, corporate_id: job.corporate_id, role: "scraper", name: job.name },
    mintAccessToken(identity, false),  // GAMEPLAN_API — without
  );
  // The pipeline tags every queued write with this job's identity.
  api.jobContext = { jobId, storeId, corporateId: job.corporate_id };

  const attempt = async () => {
    const session = await openBrowser({
      profile: `job-${storeId}`,
      onStage: (s) => log(`[${tag}] ${s}`),
      proxyOverride: job.proxy || undefined,
      noProxy: !job.proxy,
    });
    const { browser, page } = session;
    try {
      const restored = await injectCookies(page, job.cookies);
      log(`[${tag}] ${restored ? `restored ${job.cookies.length} cookie(s)` : "no cookies in job — will sign in"}`);

      const entered = await enterCrm(page, creds, { restored, onLog: (m) => log(`[${tag}] ${m}`) });
      const crmPage = entered.page;
      if (!crmPage) throw new Error("could not reach the CRM");

      // Publish cookies as soon as we're in, so a later crash doesn't cost the
      // session we just established.
      await publishSession({ storeId, cookies: await collectCookies(crmPage) }).catch(() => {});

      const context = crmPage.browserContext();
      const result = await runStorePipeline(
        crmPage, context, api,
        { targetDate: job.target_date, ...(job.config || {}) },
        (m) => log(`[${tag}] ${m}`),
      );

      await publishSession({ storeId, cookies: await collectCookies(crmPage) }).catch(() => {});
      return result;
    } finally {
      try { await browser.close(); } catch {}
    }
  };

  try {
    const result = await attempt();
    await publishEvent({ jobId, storeId, event: "done", detail: result || {} });
    log(`[${tag}] finished`);
    return 0;
  } catch (err) {
    log(`[${tag}] failed: ${err.message}`);
    if (looksLikeProxyBlock(err)) {
      // The dispatcher owns crm_proxy_bindings; tell it to retire this IP.
      await publishEvent({
        jobId, storeId, event: "proxy_blocked",
        detail: { proxy: job.proxy ? `${job.proxy.host}:${job.proxy.port}` : null, error: err.message },
      }).catch(() => {});
    }
    await publishEvent({ jobId, storeId, event: "failed", detail: { error: err.message } }).catch(() => {});
    return 1;
  }
}

main()
  .then(async (code) => {
    await closeRedis();
    log(`Exiting with code ${code}`);
    process.exit(code);
  })
  .catch(async (err) => {
    log(`Fatal: ${err.stack || err.message}`);
    await closeRedis();
    process.exit(1);
  });
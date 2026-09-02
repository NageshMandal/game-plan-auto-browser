// ---------------------------------------------------------------------------
// src/config.js — one place for every host, URL, and tunable.
//
// The CRM moved from the old eLead host (www.eleadcrm.com) to ConnectCDK's
// new Unify shell. The APP is reached at app-unify.app.connectcdk.com, but
// once you are inside "Modern Retail CRM" the eLead pages themselves are
// served from crm.connectcdk.com — same eLead app, same paths, new host.
//
// The scraper extension's DOM code (assets/content.js, assets/desklog_
// extractor.js) was written against www.eleadcrm.com and builds absolute
// URLs with that host baked in. We inject those files UNCHANGED and then
// rewrite any www.eleadcrm.com URL they emit to CRM_HOST at the seam
// (see src/scrape/inject.js → rehostUrl). That keeps the scraping logic
// byte-for-byte identical to the extension while pointing it at the new host.
// ---------------------------------------------------------------------------
import "dotenv/config";

// How many stores to scrape AT THE SAME TIME. Each concurrent store is a full
// Chrome instance with its own proxy, plus PHASE_WORKERS tabs inside it — so
// the real tab count is STORE_CONCURRENCY × PHASE_WORKERS. Budget roughly
// 0.5–1 GB RAM per store. Default 1 (sequential, the safest).
export const STORE_CONCURRENCY = Number(process.env.STORE_CONCURRENCY) || 1;

// How long to wait for the SAML chain to land on the CRM before retrying, and
// how many attempts to make. Parking on Okta for minutes never recovers on its
// own — a fresh SSO navigation is far more likely to succeed than waiting, so
// the default is a short 15s window with 3 quick attempts.
export const SSO_WAIT_MS = Number(process.env.SSO_WAIT_MS) || 15000;
export const SSO_ATTEMPTS = Number(process.env.SSO_ATTEMPTS) || 3;

// The Okta SAML entry point for the CRM app. eLead CANNOT be entered by
// navigating to index.aspx directly: with no session it redirects to
// login.asp?logout=1 and tears down any session that existed. The correct entry
// is the SP-initiated SAML URL, e.g.
//   https://connectcdk.okta.com/app/connectcdk_crmhomeconnectcdknew_1/<id>/sso/saml
// The agent normally DISCOVERS this automatically by watching the Unify app
// frame after clicking the card. Set this only if discovery fails (the value is
// tenant-specific — copy it from the address bar when the CRM opens manually).
export const CRM_SSO_URL = process.env.CRM_SSO_URL || "";

// The Unify shell we log into. Overridable, but this is the "applications"
// launcher page the browser agent already targeted.
export const UNIFY_APP_URL =
  process.env.TARGET_URL || "https://app-unify.app.connectcdk.com/applications";

// The eLead CRM host, post-migration. Everything the old scraper pointed at
// www.eleadcrm.com now lives here. Overridable via env for the next move.
export const CRM_HOST = process.env.CRM_HOST || "crm.connectcdk.com";

// The old host the injected DOM assets still hard-code. We rewrite it → CRM_HOST.
export const LEGACY_CRM_HOST = "www.eleadcrm.com";

// eLead track root + a couple of fixed landing pages, built on CRM_HOST.
export const CRM_ORIGIN = `https://${CRM_HOST}`;
export const ELEAD_TRACK = `${CRM_ORIGIN}/evo2/fresh/elead-v45/elead_track`;
export const ELEAD_INDEX_URL = `${ELEAD_TRACK}/index.aspx`;
export const ELEAD_TRACK_ROOT = `${ELEAD_TRACK}/`;
export const REPORTS_URL = `${ELEAD_TRACK}/reports/customReport.aspx`;

// The "Modern Retail CRM" launcher card inside Unify. The card id / testid
// are stable hooks; the styled-components classes are build-hash garbage.
export const MODERN_RETAIL_CRM_CARD_SELECTORS = [
  '[data-testid="card-modern-retail-crm"]',
  "#wf-card-modern-retail-crm",
  '[id*="modern-retail-crm" i]',
];

// Backend services (unchanged from the extension's auth.js).
export const GAMEPLAN_API =
  process.env.GAMEPLAN_API || "https://gameplanagent.gameplanauto.com";
export const SCRAPER_API =
  process.env.SCRAPER_API || "https://scraper.gameplanauto.com";

// ── Redis buffer ────────────────────────────────────────────────────────────
// QUEUE_MODE=redis makes scrapers write into a Redis stream instead of POSTing
// straight to the backend; drain.js replays them at a controlled rate. Any
// other value keeps the original direct-POST behaviour.
export const QUEUE_MODE = (process.env.QUEUE_MODE || "direct").toLowerCase();
export const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
export const QUEUE_STREAM = process.env.QUEUE_STREAM || "gameplan:writes";
export const SESSION_STREAM = process.env.SESSION_STREAM || "gameplan:sessions";
export const EVENT_STREAM = process.env.EVENT_STREAM || "gameplan:events";
export const QUEUE_GROUP = process.env.QUEUE_GROUP || "drain";
// Cap the stream so a stalled drain worker cannot exhaust Redis memory.
export const QUEUE_MAXLEN = Number(process.env.QUEUE_MAXLEN) || 500000;
// THIS is your backend load — not the number of scrapers.
export const DRAIN_CONCURRENCY = Number(process.env.DRAIN_CONCURRENCY) || 10;
export const DRAIN_BATCH = Number(process.env.DRAIN_BATCH) || 50;
// How long before a crashed worker's un-acked messages are reclaimed.
export const CLAIM_IDLE_MS = Number(process.env.CLAIM_IDLE_MS) || 120000;

// Credential decryption. The Python backend encrypts elead_password_enc with a
// Fernet cipher whose key is EITHER:
//   • ELEAD_CRED_KEY (env), used verbatim — when user.elead_key_source == 'env'
//   • otherwise derived from JWT_SECRET via PBKDF2-HMAC-SHA256 (200k, 32 bytes,
//     base64url) — when elead_key_source == 'jwt'.
// We mirror both here so the browser agent can decrypt each store's CRM
// password. JWT_SECRET must match the backend's for the derived path to work.
export const JWT_SECRET =
  process.env.JWT_SECRET || "gameplan-change-this-in-production-!@#$%";

// Lifetime of a self-minted access token (minutes). Must be ≥ the longest a
// single store's run can take. The backend default is short; we widen it here
// so a slow store never has its token expire mid-run (authedFetch has no
// password to re-login with). 12h by default.
export const JWT_ACCESS_EXPIRE_MINUTES =
  Number(process.env.JWT_ACCESS_EXPIRE_MINUTES) || 720;

// The two backends disagree about these claims, so gpAuth mints TWO tokens:
//
//   server.js (SCRAPER_API) calls jwt.verify(..., { issuer, audience }) and
//     REJECTS a token that lacks them.
//   FastAPI (GAMEPLAN_API) calls jwt.decode(...) with NO audience param, and
//     PyJWT raises InvalidAudienceError if the token HAS an aud claim.
//
// These must match server.js's JWT_ISSUER / JWT_AUDIENCE defaults.
export const JWT_ISSUER = process.env.JWT_ISSUER || "gameplan-api";
export const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "gameplan-app";

// Timezone the daily schedule is anchored to. The brief says "USA time":
// 23:30 flush and 00:00 scrape are evaluated in this zone. America/New_York
// by default; override for a different market.
export const SCHEDULE_TZ = process.env.SCHEDULE_TZ || "America/New_York";

// Daily schedule (local to SCHEDULE_TZ). 23:30 → flush staging→leads for every
// store; 00:00 → begin the scrape run across every scraper account.
export const FLUSH_AT = process.env.FLUSH_AT || "23:30";
export const SCRAPE_AT = process.env.SCRAPE_AT || "00:00";

// Parallel worker tabs for the per-store lead scrape (Phase 2). Mirrors the
// extension's PHASE3_WORKERS = 5.
export const PHASE_WORKERS = Number(process.env.PHASE_WORKERS) || 5;

// Recheck parallelism, mirrors the extension's PARALLEL_TABS = 5.
export const RECHECK_TABS = Number(process.env.RECHECK_TABS) || 5;

// Per-page / per-lead timeouts (ms), copied from the extension's constants.
export const DRILLDOWN_PAGE_TIMEOUT = Number(process.env.DRILLDOWN_PAGE_TIMEOUT) || 25000;
export const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 180000;
export const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS) || 60000;

// Which Lead Source Stats columns to walk (extension parity).
export const LEADSOURCE_COLUMNS = ["Good Leads", "Appts Due", "Appts Shown", "Sold"];

// Flow visit-feedback messaging safety switch. Default OFF (dry-run: type only).
export const SEND_MESSAGES = String(process.env.SEND_MESSAGES || "false").toLowerCase() === "true";
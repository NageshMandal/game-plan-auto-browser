# game-plan-auto-browser

Launches real Chrome through `puppeteer-real-browser` (optionally via a rotating
proxy pool), opens ConnectCDK Unify, follows the SSO redirect to the login page,
reports where it landed, and closes the browser.

## Requirements

| | |
|---|---|
| Node.js | 18.17+ (20 LTS recommended) — `node -v` |
| Google Chrome | **must be installed.** This drives your system Chrome; it does *not* download its own Chromium like plain puppeteer. |
| OS | Windows / macOS / Linux. On Linux you also need `Xvfb` (`sudo apt install xvfb`); on Windows and macOS it is disabled automatically. |

## Setup (PowerShell)

```powershell
cd D:\game-plan-auto-browser

npm install

copy .env.example .env
notepad .env          # fill in the proxy, or set PROXY_HOST_CONNECTCDK=direct
notepad proxies.txt   # if using the file-based pool
```

## Run

```powershell
npm start                     # normal run, proxy from .env
npm run direct                # force a direct connection (no proxy)
npm run headless              # headless — debug only, detection is worse
node index.js --keep-open 30  # hold the window open 30s before closing
```

Flags are used instead of env prefixes because `HEADLESS=true node index.js` is
bash syntax and fails in PowerShell.

## What a good run looks like

```
  [  0.0s] Routing connectcdk through proxy 45.38.107.97:6014 (1 of 10 in the pool)
  [  2.4s] Opening the applications URL
  [  3.1s] nav https://app-unify.app.connectcdk.com/applications
  [  3.9s] Waiting for the redirect to the login page
  [  4.6s] nav https://.../authorize?client_id=...
────────────────────────────────────────────────────────────────────
  landed   : https://.../authorize?client_id=...
  detected : URL is an auth endpoint
────────────────────────────────────────────────────────────────────
  [  5.2s] Closing the browser
```

## Files

```
index.js            the run: navigate, wait for redirect, close
src/browser.js      the ONLY place Chrome is launched (proxy + launch gap)
.env                your config (gitignored)
proxies.txt         host:port:user:pass, one per line (gitignored)
```

## Two things not to change

**`customConfig` stays empty.** The tempting optimisation is a persistent
`userDataDir` so a solved bot-check survives between runs. It backfires:
`puppeteer-real-browser` prepares its own throwaway profile with the preferences
and flags that stop Chrome looking automated, and it expects to own that
directory. Pointing it at your own skips that preparation entirely, and Chrome
gets challenged on every attempt. The throwaway profile *is* the mechanism.

**`disableXvfb` is derived from `process.platform`.** Xvfb is an X11 virtual
display — it does not exist on Windows. Hard-coding `disableXvfb: false` makes
the launch hang or throw before Chrome starts.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Failed to launch the browser process` | Chrome not installed, or not on PATH |
| Page never loads, any URL | dead/unauthorised proxy — run `npm run direct` to confirm |
| `'HEADLESS=true' is not recognized` | bash syntax in PowerShell — use `npm run headless` |
| Timeout with `still at .../applications` | it rendered without redirecting; the tenant may already hold a session cookie, or the URL is wrong |
| Orphaned `chrome.exe` after a crash | `Get-Process chrome \| Stop-Process` |

---

# Daily automation system

Beyond the single-target login (`npm start`), this project now runs the **entire
nightly scrape** unattended — replacing "open the scraper extension and click
Run every night." All of the extension's DOM scraping logic and its server-side
pipeline are ported in and driven by a scheduler.

## What it does, per night (in `SCHEDULE_TZ`, default `America/New_York`)

1. **23:30 — flush.** For every scraper account, move staging → the `leads`
   collection (the same per-store `/api/flush-staging` the old server cron ran).
2. **00:00 — scrape.** The date has changed, so it runs every scraper account in
   turn. For each store:
   - read `gameplan.users` where `role:'scraper'` and `active:true`;
   - decrypt that store's CRM login (`elead_email` + `elead_password_enc`) — if
     either is missing/undecryptable the store is **skipped**;
   - allocate the store's **dedicated proxy IP** (see rules below);
   - launch Chrome (the **unchanged** `openBrowser` launch system), restore the
     store's cookies from Mongo, log into Unify, click **Modern Retail CRM**;
   - run the full desklog pipeline — Lead Source (id=1829), Showroom
     (id=251 → id=1987 drilldowns), URL discovery, store visits, month-to-date
     sold reconciliation, a **5-tab** lead scrape, then **5-tab** rechecks;
   - on completion call `markScrapeDone` (arms the agent), save the refreshed
     session back to Mongo, close the browser, move to the next store.

The CRM moved from `www.eleadcrm.com` to `crm.connectcdk.com`. The injected
scraper assets are used **byte-for-byte**; any `www.eleadcrm.com` URL they emit
is rewritten to `CRM_HOST` at the injection seam, so the scraping logic is
identical to the extension.

## Run it

```bash
npm run daily          # start the resident daemon (schedules 23:30 + 00:00)
npm run scrape-now     # run the 00:00 scrape for all stores immediately, then exit
npm run flush-now      # run the 23:30 flush for all stores immediately, then exit
node daily.js --store <store_id>            # run one store now, then exit
node daily.js --scrape-now --date 2026-08-20  # scrape a specific target date
```

Keep it alive with `pm2 start daily.js --name gp-daily`, a `systemd` unit, or a
Windows service — the daemon self-re-arms each day and is DST-safe.

## Proxy rules (Mongo-backed, `crm_proxy_bindings`)

- Each CRM account gets **one dedicated IP**, reused every day.
- An IP bound to a live account is **off-limits** to every other account.
- If entry fails in a block-like way, the IP is **retired** (freed for reuse)
  and the account rebinds to a fresh IP and retries once.
- If an account's pinned IP is **removed** from `proxies.txt` and new IPs added,
  the account **rebinds** to an IP not yet held by another account.

Cookies are stored in Mongo as **one document per account** (`crm_sessions`),
updated in place each run.

## Auth (no gameplan password needed)

The daemon **self-mints** an HS256 access token per store from `JWT_SECRET`,
carrying `sub/role/store_id/corporate_id/name/type:access` — exactly what both
backends verify. The gameplan account password is bcrypt-hashed and not
recoverable, so this is used instead of a login round-trip. `JWT_SECRET` **must**
match the backends' or every authed call 401s (and that store is skipped).

## New environment

See `.env.example`. Key additions: `MONGO_URI`, `GAMEPLAN_DB`, `JWT_SECRET`,
`ELEAD_CRED_KEY` (only when `elead_key_source == 'env'`; otherwise derived from
`JWT_SECRET`), `GAMEPLAN_API`, `SCRAPER_API`, `SCHEDULE_TZ`, `FLUSH_AT`,
`SCRAPE_AT`, `PHASE_WORKERS`, `RECHECK_TABS`, `SEND_MESSAGES`.

## New files

| File | Role |
|---|---|
| `daily.js` | daemon entry — schedules the flush + scrape, one-shot flags |
| `src/scrape/scheduler.js` | timezone-aware "HH:MM in SCHEDULE_TZ" scheduling |
| `src/scrape/runStore.js` | per-store: proxy → launch → login → pipeline → retry |
| `src/scrape/pipeline.js` | ported desklog pipeline (reports, discovery, scrape, rechecks) |
| `src/scrape/leadScraper.js` | ported `scrapeLeadAllPages` (main + tabs + sub-pages) |
| `src/scrape/crmLogin.js` | Unify login + Modern Retail CRM card click |
| `src/scrape/session.js` | Mongo cookie save/restore (one doc per store) |
| `src/scrape/inject.js` | injects `assets/content.js` + `desklog_extractor.js` verbatim |
| `src/scrape/api.js` | both backends (scraper Express + gameplan FastAPI) |
| `src/scrape/gpAuth.js` | self-mint HS256 access tokens |
| `src/store/mongo.js` | users, sessions, proxy bindings |
| `src/store/proxyAllocator.js` | the four proxy rules |
| `src/store/credentials.js` | Fernet decryption of the CRM password |
| `assets/*.js` | the extension's DOM code, unchanged |

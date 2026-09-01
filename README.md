# Project 2 — Browser Agent

Ephemeral. **One CRM account per instance.** Talks only to Redis.

```
┌────────────┐        ┌──────────────────────────┐        ┌─────────────┐
│  MongoDB   │◄──────►│  Project 3 (24/7)        │◄──────►│ THIS AGENT  │
│            │        │  dispatcher + writer     │ Redis  │ ephemeral   │
└────────────┘        └──────────────────────────┘  only  └─────────────┘
```

**This project has no database driver, no Mongo URI, and no Fernet key.** It
cannot reach the database even if misconfigured — there is no `mongodb` package
in `package.json`. Everything it needs arrives in a job payload; everything it
produces goes back through Redis. See `CONTRACT.md`.

## Run

```bash
npm install
JOB_ID=<id> REDIS_URL=redis://your-redis:6379 node agent.js
```

On EC2 the dispatcher injects `JOB_ID` via user-data; nothing else is needed.

Exit codes, read by the orchestrator:

| code | meaning |
|---|---|
| 0 | scraped successfully |
| 2 | nothing to do (job missing/expired, or no credentials in it) |
| 1 | failed |

## What it does

1. Claims `job:{JOB_ID}` from Redis and **deletes it immediately** — the job
   carries the decrypted CRM password, so it should not linger.
2. Launches Chrome (`puppeteer-real-browser`) through the proxy given in the
   job, with a throwaway profile.
3. Injects the cookies from the job, opens Unify, clicks Modern Retail CRM,
   captures the Okta SAML URL, and enters the CRM in a second tab. The Unify
   tab stays open — navigating it away logs eLead out.
4. Runs the pipeline: Lead Source report → Showroom → store visits → sold
   reconciliation → 5-tab lead scrape → 5-tab rechecks → `markScrapeDone`.
5. Publishes every write to `gameplan:writes`, cookies to `gameplan:sessions`,
   and lifecycle/proxy signals to `gameplan:events`.
6. Exits. The instance terminates itself.

## Building the AMI

```bash
bash deploy/setup-droplet.sh      # Node 20, Chrome, Xvfb, fonts, user
mkdir -p /opt/game-plan-auto-browser
# upload this project, then:
cd /opt/game-plan-auto-browser && npm install --omit=dev
```

**Xvfb is mandatory.** `browser.js` sets `disableXvfb: false` on Linux, so
without it Chrome never starts. Verify with a real job before snapshotting —
a broken AMI fails on every instance, not just one.

## Notes

- The Chrome profile is thrown away every launch **by design**: that disposable
  profile is what carries the anti-detection setup. Continuity comes from the
  cookies in the job, not from disk.
- `PHASE_WORKERS` is tabs within this one store, not stores. Drop it to 3 if
  you see `ERR_TUNNEL_CONNECTION_FAILED` (a proxy connection cap).
- `JWT_SECRET` is still needed here: the scraper reads a few backend endpoints
  (pending rechecks, flow config) directly. All *writes* go through Redis.

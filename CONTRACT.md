# The Redis contract — the only interface between Project 2 and Project 3

```
┌────────────┐        ┌──────────────────────────┐        ┌─────────────┐
│ 1. MongoDB │◄──────►│ 3. Python service (24/7)  │◄──────►│  2. Agent   │
└────────────┘  only  │    dispatcher + writer    │  only  │ (ephemeral) │
                 3    │         + Redis           │ Redis  └─────────────┘
                      └──────────────────────────┘
```

**Project 2 has no Mongo driver, no Mongo URI, and no Fernet key.** It cannot
reach the database even if misconfigured. Everything it needs arrives in a job
payload; everything it produces goes back through Redis.

---

## 1. Job handoff — `job:{job_id}` (string, JSON, TTL 3600s)

Written by the **dispatcher** before the instance launches. The instance is
given only `JOB_ID` (via EC2 user-data) and `REDIS_URL`.

```json
{
  "job_id": "6a452e13-2026-08-24",
  "store_id": "6a452e134276fc56aad97326",
  "corporate_id": "69f9b6c85de85ca1bebb8d26",
  "name": "DCJR Scraper",
  "crm_username": "fletchersherwood158@gmail.com",
  "crm_password": "decrypted-by-project-3",
  "proxy": { "host": "31.59.20.176", "port": 6754, "username": "u", "password": "p" },
  "cookies": [ { "name": "sid", "domain": "connectcdk.okta.com", "...": "" } ],
  "crm_sso_url": "",
  "target_date": "2026-08-23",
  "config": { "phaseWorkers": 5, "recheckTabs": 5, "sendMessages": false }
}
```

The agent deletes this key once it has read it, so the plaintext password lives
in Redis for seconds, not the whole run.

> **Security note.** The CRM password crosses Redis in plaintext because the
> agent has no Fernet key by design. Use TLS (`rediss://`), require AUTH, keep
> Redis in a private subnet, and rely on the short TTL. The alternative — giving
> every ephemeral instance the Fernet key — is worse: the key would be baked
> into an AMI that outlives the run.

## 2. Scraped data — `gameplan:writes` (stream)

Written by the agent, consumed by the **writer**. One entry per backend write.

| field | meaning |
|---|---|
| `job_id`, `store_id`, `corporate_id` | routing + auth context |
| `path` | backend endpoint, e.g. `/api/process-lead` |
| `body` | JSON payload |
| `queuedAt` | ISO timestamp |

Consumer group `writer` with `XACK` only after Mongo/backend accepts, so a
crashed writer replays rather than loses.

## 3. Session write-back — `gameplan:sessions` (stream)

The agent can't persist cookies itself. It publishes them; the writer upserts
into `crm_sessions` (one doc per store).

| field | meaning |
|---|---|
| `store_id` | which store |
| `cookies` | JSON array, already filtered by the agent |

## 4. Events — `gameplan:events` (stream)

Lifecycle and proxy signals. This is how the **dispatcher** learns a proxy is
blocked, since the agent can't touch `crm_proxy_bindings`.

| `event` | meaning / dispatcher action |
|---|---|
| `started` | instance began work |
| `proxy_blocked` | retire the binding, rebind next run |
| `done` | counts in `detail`; mark the run complete |
| `failed` | `detail` carries the error |

---

## Responsibilities

**Project 3 — dispatcher (Python, 24/7)**
1. Read `gameplan.users` for `role:'scraper'`, active, with CRM email.
2. Decrypt `elead_password_enc` (Fernet).
3. Resolve the proxy from `crm_proxy_bindings` (the four rules live here now).
4. Load the store's cookies from `crm_sessions`.
5. Write `job:{job_id}`, launch the EC2 instance with `JOB_ID`.

**Project 2 — agent (Node, ephemeral)**
1. Read `JOB_ID`, fetch and delete the job from Redis.
2. Launch Chrome through the given proxy, restore given cookies, enter the CRM.
3. Scrape; `XADD` every write to `gameplan:writes`.
4. Publish cookies to `gameplan:sessions`, lifecycle to `gameplan:events`.
5. Exit; the instance terminates.

**Project 3 — writer (Python, 24/7)**
1. `XREADGROUP` from `gameplan:writes` → POST to the backend (or write Mongo
   directly) at a controlled rate → `XACK`.
2. Consume `gameplan:sessions` → upsert `crm_sessions`.
3. Consume `gameplan:events` → retire proxies, record run status.

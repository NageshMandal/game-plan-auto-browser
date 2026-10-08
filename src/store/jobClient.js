// ---------------------------------------------------------------------------
// src/store/jobClient.js — the agent's ONLY outbound channel.
//
// Project 2 has no MongoDB driver and no database credentials. Everything it
// needs arrives in a job payload from Redis; everything it produces is
// published back to Redis for the Python writer to persist.
//
// See CONTRACT.md for the full schema.
// ---------------------------------------------------------------------------
import { createClient } from "redis";
import {
  REDIS_URL, QUEUE_STREAM, SESSION_STREAM, EVENT_STREAM, QUEUE_MAXLEN,
} from "../config.js";

let _client = null;

export async function getRedis() {
  if (_client) return _client;
  _client = createClient({
    url: REDIS_URL,
    socket: {
      connectTimeout: 15000,
      reconnectStrategy: (n) => (n > 10 ? false : Math.min(n * 300, 3000)),
    },
  });
  _client.on("error", () => {}); // callers surface failures themselves
  await _client.connect();
  return _client;
}

export async function closeRedis() {
  if (_client) {
    try { await _client.quit(); } catch {}
    _client = null;
  }
}

/**
 * Fetch this instance's job and DELETE it immediately.
 *
 * The payload carries the decrypted CRM password, so it should exist in Redis
 * for as little time as possible. We read and delete in one round trip via
 * GETDEL (Redis 6.2+), falling back to GET+DEL on older servers.
 */
export async function claimJob(jobId) {
  const client = await getRedis();
  const key = `job:${jobId}`;
  let raw = null;
  try {
    raw = await client.getDel(key);
  } catch {
    raw = await client.get(key);
    if (raw) await client.del(key).catch(() => {});
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Job ${jobId} is not valid JSON: ${err.message}`);
  }
}

// ── Heartbeat ──
// While the agent is alive it keeps `agent:alive:<store_id>` set in Redis
// (it expires by itself three minutes after the last beat). The dispatcher
// reads it to tell a store that is still working from one that died: a run
// has no fixed length any more, so "it has been 110 minutes" no longer means
// "it failed", and relaunching a store whose agent is still running would put
// two sessions on the same CRM account.
const HEARTBEAT_EVERY_MS = 45000;
const HEARTBEAT_TTL_S = 180;
let _beat = null;
let _beatKey = null;

export async function startHeartbeat({ storeId, jobId }) {
  if (!storeId || _beat) return;
  _beatKey = `agent:alive:${storeId}`;
  const startedAt = new Date().toISOString();
  const beat = async () => {
    try {
      const client = await getRedis();
      await client.set(_beatKey, JSON.stringify({ job_id: String(jobId || ""), started_at: startedAt, at: new Date().toISOString() }),
        { EX: HEARTBEAT_TTL_S });
    } catch { /* a missed beat is covered by the TTL */ }
  };
  await beat();
  _beat = setInterval(beat, HEARTBEAT_EVERY_MS);
  if (_beat.unref) _beat.unref();           // never keeps the process alive by itself
}

export async function stopHeartbeat() {
  if (_beat) { clearInterval(_beat); _beat = null; }
  if (_beatKey) {
    try { const client = await getRedis(); await client.del(_beatKey); } catch {}
    _beatKey = null;
  }
}

// Every backend write the scraper produces. The writer replays these to the
// main server / Mongo at a controlled rate.
export async function publishWrite({ jobId, storeId, corporateId, path, body }) {
  const client = await getRedis();
  await client.xAdd(
    QUEUE_STREAM,
    "*",
    {
      job_id: String(jobId || ""),
      store_id: String(storeId || ""),
      corporate_id: String(corporateId || ""),
      path: String(path),
      body: JSON.stringify(body ?? {}),
      queuedAt: new Date().toISOString(),
    },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: QUEUE_MAXLEN } },
  );
  return true;
}

// Cookies for this store. The agent cannot write crm_sessions itself.
export async function publishSession({ storeId, cookies }) {
  const client = await getRedis();
  await client.xAdd(
    SESSION_STREAM,
    "*",
    {
      store_id: String(storeId || ""),
      cookies: JSON.stringify(cookies || []),
      savedAt: new Date().toISOString(),
    },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10000 } },
  );
  return true;
}

/**
 * Lifecycle + proxy signals. `proxy_blocked` is how the dispatcher learns to
 * retire a binding, since the agent has no access to crm_proxy_bindings.
 */
export async function publishEvent({ jobId, storeId, event, detail = {} }) {
  const client = await getRedis();
  await client.xAdd(
    EVENT_STREAM,
    "*",
    {
      job_id: String(jobId || ""),
      store_id: String(storeId || ""),
      event: String(event),
      detail: JSON.stringify(detail),
      at: new Date().toISOString(),
    },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 50000 } },
  );
  return true;
}

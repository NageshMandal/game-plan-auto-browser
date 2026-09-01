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

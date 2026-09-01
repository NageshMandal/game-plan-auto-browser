// ---------------------------------------------------------------------------
// src/store/queue.js — buffer scraped writes in Redis instead of POSTing them
// straight to the backend.
//
// WHY: with 100 stores scraping concurrently, every instance POSTs leads to the
// backend at the same time. The backend becomes the bottleneck, instances stay
// alive (and billing) waiting on slow responses, and if the backend hiccups the
// data is simply lost. Buffering decouples the two: scrapers write to Redis at
// full speed and terminate, and a drain worker feeds the backend at whatever
// rate it can actually sustain.
//
// WHY STREAMS, NOT A LIST: a plain LPUSH/RPOP loses a message if the consumer
// dies between popping and delivering. Redis Streams with a consumer group hold
// the message in a pending list until it is explicitly XACK'd, so a crashed
// drain worker's messages are re-delivered rather than lost.
//
// Enable with QUEUE_MODE=redis. Anything else keeps the original direct-POST
// behaviour, so this is opt-in and reversible.
// ---------------------------------------------------------------------------
import { createClient } from "redis";
import { REDIS_URL, QUEUE_STREAM, QUEUE_MAXLEN } from "../config.js";

let _client = null;
let _failed = false; // once Redis is unreachable, stop retrying every write

export async function getRedis() {
  if (_client) return _client;
  if (_failed) return null;
  try {
    _client = createClient({
      url: REDIS_URL,
      socket: { connectTimeout: 10000, reconnectStrategy: (n) => (n > 5 ? false : Math.min(n * 200, 2000)) },
    });
    _client.on("error", () => {}); // handled by callers; don't spam logs
    await _client.connect();
    return _client;
  } catch {
    _failed = true;
    _client = null;
    return null;
  }
}

export async function closeRedis() {
  if (_client) {
    try { await _client.quit(); } catch {}
    _client = null;
  }
}

/**
 * Queue one backend write.
 *
 * The message carries everything the drain worker needs to replay it without
 * any scraper context: the endpoint path, the body, and the store identity so
 * the worker can mint the right per-store JWT.
 *
 * @returns {Promise<boolean>} true if queued; false means the caller should
 *          fall back to a direct POST (Redis down — never drop the data).
 */
export async function enqueueWrite({ path, body, storeId, corporateId, name = "" }) {
  const client = await getRedis();
  if (!client) return false;
  try {
    await client.xAdd(
      QUEUE_STREAM,
      "*",
      {
        path,
        storeId: String(storeId || ""),
        corporateId: String(corporateId || ""),
        name: String(name || ""),
        queuedAt: new Date().toISOString(),
        body: JSON.stringify(body ?? {}),
      },
      // Cap the stream so a stalled drain worker can't exhaust Redis memory.
      // '~' makes trimming approximate, which is much cheaper for Redis.
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: QUEUE_MAXLEN } },
    );
    return true;
  } catch {
    return false;
  }
}

/** Current backlog depth — useful for monitoring and for the drain worker. */
export async function queueDepth() {
  const client = await getRedis();
  if (!client) return null;
  try {
    return await client.xLen(QUEUE_STREAM);
  } catch {
    return null;
  }
}

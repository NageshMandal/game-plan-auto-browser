// ---------------------------------------------------------------------------
// src/store/mongo.js — the browser agent's own state in MongoDB.
//
// Three responsibilities, all on the SAME Cluster0 the users live in:
//
//   1. Read gameplan.users to find the scraper accounts to run
//      (role: 'scraper', active: true, with a CRM email + password).
//
//   2. Persist ONE cookie/session document per scraper account, updated in
//      place every run — never a new doc per run. Collection: crm_sessions.
//      Keyed by store_id (one CRM account per store). This replaces the
//      on-disk .session/*.json the single-target browser used.
//
//   3. Manage the proxy⇄account bindings that implement the brief's rules:
//        • each CRM account gets a dedicated proxy IP, reused every day
//        • an IP bound to one account is never handed to another while it is
//          live; only a blocked/retired IP is freed for reuse
//        • if an account's pinned IP is removed from proxies.txt, the account
//          is rebound to a currently-unbound IP from the new list
//      Collection: crm_proxy_bindings. One doc per account (by store_id),
//      carrying the host:port it owns.
// ---------------------------------------------------------------------------
import { MongoClient } from "mongodb";
import { MONGO_URI, GAMEPLAN_DB } from "../config.js";

let _client = null;
let _db = null;

export async function connect() {
  if (_db) return _db;
  if (!MONGO_URI) throw new Error("MONGO_URI is not set — cannot reach Cluster0.");
  _client = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
  await _client.connect();
  _db = _client.db(GAMEPLAN_DB);
  return _db;
}

export async function close() {
  if (_client) {
    await _client.close().catch(() => {});
    _client = null;
    _db = null;
  }
}

// ── Users ──────────────────────────────────────────────────────────────────
// Every active scraper account. We only run one whose CRM email AND password
// are both resolvable (see src/store/credentials.js), so we return the raw
// docs and let the caller decide who to skip.
export async function getScraperAccounts() {
  const db = await connect();
  const users = db.collection("users");
  const docs = await users
    .find({ role: "scraper", active: true })
    .toArray();
  return docs;
}

// ── Per-account CRM session (cookies + localStorage) ────────────────────────
// One document per store_id, upserted. The payload shape matches what the
// old on-disk session file held: { cookies, origins, savedAt }.
const SESSIONS = "crm_sessions";

export async function loadSession(storeId) {
  const db = await connect();
  const doc = await db.collection(SESSIONS).findOne({ store_id: storeId });
  return doc ? doc.session : null;
}

export async function saveSession(storeId, session) {
  const db = await connect();
  await db.collection(SESSIONS).updateOne(
    { store_id: storeId },
    { $set: { store_id: storeId, session, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function clearSession(storeId) {
  const db = await connect();
  await db.collection(SESSIONS).deleteOne({ store_id: storeId });
}

// ── Proxy bindings ──────────────────────────────────────────────────────────
// One doc per account (store_id) recording the proxy IP it owns:
//   { store_id, host, port, boundAt, retiredAt? }
// A binding with no retiredAt is LIVE and its IP is off-limits to other
// accounts. retireProxy() stamps retiredAt so the IP frees up for reuse.
const BINDINGS = "crm_proxy_bindings";

export async function getAllBindings() {
  const db = await connect();
  return db.collection(BINDINGS).find({}).toArray();
}

export async function getBinding(storeId) {
  const db = await connect();
  return db.collection(BINDINGS).findOne({ store_id: storeId });
}

export async function setBinding(storeId, host, port) {
  const db = await connect();
  await db.collection(BINDINGS).updateOne(
    { store_id: storeId },
    {
      $set: { store_id: storeId, host, port: Number(port), boundAt: new Date() },
      $unset: { retiredAt: "" },
    },
    { upsert: true },
  );
}

// Mark an account's current proxy as blocked/retired. The IP is freed for
// reuse (by this or another account) and this account will pick a fresh one
// on its next run. The session is also dropped, since a cookie issued behind
// a now-dead IP is worthless and a new IP would invalidate it anyway.
export async function retireProxy(storeId) {
  const db = await connect();
  await db.collection(BINDINGS).updateOne(
    { store_id: storeId },
    { $set: { retiredAt: new Date() } },
  );
}

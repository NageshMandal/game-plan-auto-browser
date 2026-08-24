// ---------------------------------------------------------------------------
// src/store/proxyAllocator.js — dedicated proxy IP per CRM account.
//
// Implements the four rules from the brief, backed by crm_proxy_bindings:
//
//   1. Each CRM account has a dedicated proxy IP, reused every day.
//      → resolveProxyForAccount returns the account's LIVE binding if its IP
//        is still in proxies.txt. Same account → same IP, every run.
//
//   2. If the proxy is blocked, change it.
//      → the run marks it retired (mongo.retireProxy); next resolve treats the
//        account as unbound and assigns a fresh, currently-unused IP.
//
//   3. An IP in use by one account is not given to another (unless the first
//      account's binding was retired/blocked, in which case it's reusable).
//      → assignment only ever picks from pool entries NOT held by a LIVE
//        binding of any other account.
//
//   4. If an account's pinned IP is removed from proxies.txt and new IPs were
//      added, the account rebinds to a not-yet-bound IP from the new list.
//      → if the live binding's host:port is absent from the current pool, we
//        drop it and assign a fresh one.
//
// The pool itself is parsed from the same proxies.txt / PROXY_LIST the browser
// already understood (host:port:user:pass per line). We reuse that parser.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { getAllBindings, getBinding, setBinding } from "./mongo.js";

// `host:port` or `host:port:user:pass` — same shape as src/browser.js.
function parseProxyEntry(raw) {
  const s = String(raw || "").trim();
  if (!s || s.startsWith("#")) return null;
  const [host, port, username, password] = s.split(":");
  const p = Number(port);
  if (!host || !Number.isFinite(p) || p <= 0) return null;
  return { host, port: p, username: username || undefined, password: password || undefined };
}

// Read every proxy from PROXY_LIST (comma/space separated) and/or the file at
// PROXY_FILE (defaults to ./proxies.txt), deduped by host:port.
export function loadProxyPool() {
  const entries = [];
  const seen = new Set();
  const add = (e) => {
    if (!e) return;
    const key = `${e.host}:${e.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(e);
  };

  const list = process.env.PROXY_LIST || process.env.PROXY_LIST_CONNECTCDK || "";
  for (const item of list.split(/[,\s]+/)) add(parseProxyEntry(item));

  const file = process.env.PROXY_FILE || process.env.PROXY_FILE_CONNECTCDK || "./proxies.txt";
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) add(parseProxyEntry(line));
  } catch {
    /* no file — PROXY_LIST alone is fine */
  }
  return entries;
}

const keyOf = (host, port) => `${host}:${Number(port)}`;

// The set of host:port strings currently owned by a LIVE binding (retiredAt
// absent) belonging to some OTHER account. Those are off-limits.
async function takenByOthers(exceptStoreId) {
  const bindings = await getAllBindings();
  const taken = new Set();
  for (const b of bindings) {
    if (b.store_id === exceptStoreId) continue;
    if (b.retiredAt) continue; // retired/blocked → its IP is reusable
    taken.add(keyOf(b.host, b.port));
  }
  return taken;
}

/**
 * Resolve the proxy an account should use this run, applying all four rules.
 * Returns a full proxy entry { host, port, username?, password? } from the
 * pool, or null if there is genuinely no free IP to hand out.
 *
 * @param {string} storeId  the account's store_id (its dedicated key)
 */
export async function resolveProxyForAccount(storeId, onLog = () => {}) {
  const pool = loadProxyPool();
  if (pool.length === 0) {
    onLog(`No proxies configured — ${storeId} will run direct`);
    return null;
  }
  const inPool = (host, port) => pool.find((e) => e.host === host && e.port === Number(port));

  const binding = await getBinding(storeId);

  // Rule 1: a live binding whose IP is still in the pool → reuse it verbatim.
  if (binding && !binding.retiredAt) {
    const still = inPool(binding.host, binding.port);
    if (still) {
      onLog(`${storeId} → pinned proxy ${still.host}:${still.port}`);
      return still;
    }
    // Rule 4: pinned IP dropped out of proxies.txt → fall through and rebind.
    onLog(`${storeId} pinned proxy ${binding.host}:${binding.port} no longer in pool — rebinding`);
  } else if (binding && binding.retiredAt) {
    // Rule 2: previously blocked → assign fresh below.
    onLog(`${storeId} previous proxy was retired — assigning a fresh one`);
  }

  // Assignment: pick a pool entry not held by another account's live binding.
  const taken = await takenByOthers(storeId);
  const free = pool.filter((e) => !taken.has(keyOf(e.host, e.port)));

  if (free.length === 0) {
    // Every pool IP is spoken for by another live account. Rather than share
    // (which the rules forbid), fail this account for the run — the operator
    // needs to add more IPs. Surfacing it is better than silently doubling up.
    onLog(`⚠ No free proxy IP for ${storeId} — every pool entry is bound to another live account`);
    return null;
  }

  // Deterministic-ish pick: first free entry. (Random would also satisfy the
  // rules, but a stable choice makes the same account tend to the same slot
  // when the pool grows, which is friendlier to the IdP's IP-stickiness.)
  const chosen = free[0];
  await setBinding(storeId, chosen.host, chosen.port);
  onLog(`${storeId} → newly bound proxy ${chosen.host}:${chosen.port}`);
  return chosen;
}

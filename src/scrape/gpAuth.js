// ---------------------------------------------------------------------------
// src/scrape/gpAuth.js — mint a per-store access token WITHOUT a password.
//
// The extension logged the scraper account into the FastAPI backend with an
// email+password to obtain tokens. We can't do that here: the gameplan account
// password is stored bcrypt-hashed on the user doc and is not recoverable, and
// the browser agent only ever has the CRM (eLead) credentials, not the gameplan
// login password.
//
// But BOTH backends that the pipeline talks to verify their tokens the same way
// — HS256 over the shared JWT_SECRET — and only read a handful of claims:
//
//   • the Node scraper server (server.js::requireAuth) needs store_id +
//     corporate_id, and exposes them as req.user.{store_id,corporate_id,role}.
//   • the FastAPI backend (security.py::decode_token) accepts any HS256 token
//     signed with JWT_SECRET and reads sub/role/store_id/corporate_id/name.
//
// So we reproduce security.py::create_access_token exactly and sign it with the
// same secret. This is the same token the backend would have minted for this
// account at login — we just skip the password round-trip. The token is short-
// lived (matches JWT_ACCESS_EXPIRE_MINUTES) and re-minted per run.
//
// Requires JWT_SECRET to match the backends'. If it doesn't, every authed call
// 401s and the store is effectively skipped (surfaced in logs) — no data leaks.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import { JWT_SECRET, JWT_ACCESS_EXPIRE_MINUTES } from "../config.js";

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function uuid4() {
  // crypto.randomUUID exists on Node ≥ 14.17; fall back just in case.
  try {
    return crypto.randomUUID();
  } catch {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

/**
 * Mint an access token for a gameplan.users doc. Mirrors the payload the Python
 * backend's create_access_token builds, so both backends accept it.
 *
 * @param {object} userDoc  a gameplan.users document (role:'scraper')
 * @returns {string} a signed HS256 JWT
 */
export function mintAccessToken(userDoc) {
  const sub = String(userDoc._id || userDoc.id || userDoc.sub || "");
  const nowSec = Math.floor(Date.now() / 1000);
  const expMin = Number(JWT_ACCESS_EXPIRE_MINUTES) || 720;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub,
    role: userDoc.role || "scraper",
    corporate_id: userDoc.corporate_id || "",
    store_id: userDoc.store_id || "",
    name: userDoc.name || "",
    type: "access",
    jti: uuid4(),
    iat: nowSec,
    exp: nowSec + expMin * 60,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

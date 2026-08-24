// ---------------------------------------------------------------------------
// src/store/credentials.js — decrypt each store's CRM password.
//
// The Python backend stores the CRM password as a Fernet token in
// user.elead_password_enc, and the CRM username in user.elead_email. This
// module reproduces the backend's key handling and Fernet decryption in Node,
// so the browser agent can turn a user doc into { username, password }.
//
// Key selection mirrors routes/user_routes.py::_elead_key():
//   • ELEAD_CRED_KEY set  → use it verbatim (elead_key_source == 'env')
//   • else                → PBKDF2-HMAC-SHA256(JWT_SECRET, "gameplan/elead-
//                            credential/v1", 200000, 32) then urlsafe-base64
//                            (elead_key_source == 'jwt')
//
// Fernet token format (spec): urlsafe-base64 of
//   version(1) | timestamp(8) | IV(16) | ciphertext(...) | HMAC-SHA256(32)
// We verify the HMAC then AES-128-CBC-decrypt with PKCS7 unpadding. The Fernet
// key's first 16 bytes are the HMAC signing key, last 16 the AES key.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import { ELEAD_CRED_KEY, JWT_SECRET } from "../config.js";

const KDF_INFO = Buffer.from("gameplan/elead-credential/v1");

// Return the raw 32-byte Fernet key (already base64url-DECODED).
function fernetKeyBytes() {
  if (ELEAD_CRED_KEY) {
    // ELEAD_CRED_KEY is itself a urlsafe-base64 Fernet key string.
    return Buffer.from(ELEAD_CRED_KEY, "base64url");
  }
  // Derived path: PBKDF2 over JWT_SECRET, then urlsafe-b64 → that string is the
  // Fernet key; decode it back to 32 raw bytes for use.
  const derived = crypto.pbkdf2Sync(
    Buffer.from(JWT_SECRET),
    KDF_INFO,
    200000,
    32,
    "sha256",
  );
  const keyStr = derived.toString("base64url"); // matches base64.urlsafe_b64encode
  return Buffer.from(keyStr, "base64url");
}

// Decrypt one Fernet token → plaintext string. Throws on tamper / wrong key.
function fernetDecrypt(token, keyBytes) {
  if (keyBytes.length !== 32) {
    throw new Error("Fernet key must be 32 bytes after base64url decode");
  }
  const signingKey = keyBytes.subarray(0, 16);
  const encryptionKey = keyBytes.subarray(16, 32);

  const data = Buffer.from(String(token), "base64url");
  if (data.length < 1 + 8 + 16 + 32 || data[0] !== 0x80) {
    throw new Error("Not a valid Fernet token");
  }
  const hmacGiven = data.subarray(data.length - 32);
  const signed = data.subarray(0, data.length - 32);

  const hmac = crypto.createHmac("sha256", signingKey).update(signed).digest();
  if (!crypto.timingSafeEqual(hmac, hmacGiven)) {
    throw new Error("Fernet HMAC mismatch — wrong key or tampered token");
  }

  const iv = data.subarray(9, 25);
  const ciphertext = data.subarray(25, data.length - 32);
  const decipher = crypto.createDecipheriv("aes-128-cbc", encryptionKey, iv);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return out.toString("utf8");
}

/**
 * Turn a gameplan.users doc into CRM credentials, or null if this account
 * has no usable CRM login (skip it, per the brief).
 *
 * @returns {{ username: string, password: string } | null}
 */
export function resolveCredentials(userDoc) {
  const username = (userDoc && userDoc.elead_email) || "";
  const enc = (userDoc && userDoc.elead_password_enc) || "";
  if (!username || !enc) return null; // "if not email and pass for crm skip it"

  try {
    const password = fernetDecrypt(enc, fernetKeyBytes());
    if (!password) return null;
    return { username, password };
  } catch (err) {
    // Undecryptable (wrong ELEAD_CRED_KEY / JWT_SECRET) → treat as no creds so
    // the store is skipped rather than crashing the whole nightly run.
    return null;
  }
}

import { createHmac } from 'node:crypto';

/**
 * coturn "TURN REST API" ephemeral credential (spec name: Time Limited Long Term Credential).
 *
 * username   = `<expiry unix seconds>:<user identifier>`
 * credential = base64(HMAC-SHA1(secret, username))
 *
 * coturn recomputes the HMAC with `use-auth-secret` + `static-auth-secret` (same secret) to verify,
 * and checks the timestamp in username has not expired. So the **long-term secret never leaves the server**;
 * the client only ever receives an expiring ticket; rotating the secret invalidates all issued tickets immediately.
 *
 * ⚠️ coturn splits username at the **first colon**, so colons inside uid must be replaced or the timestamp is truncated.
 * ⚠️ Symmetric HMAC: a leaked secret lets anyone self-sign credentials ⇒ it must stay only in the server env var.
 */
export function issueTurnCredential(secret: string, uid: string, ttlSeconds: number, now = Date.now()) {
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  const expiresAt = Math.floor(now / 1000) + ttl;
  const username = `${expiresAt}:${uid.replace(/:/g, '-')}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64'), expiresAt };
}

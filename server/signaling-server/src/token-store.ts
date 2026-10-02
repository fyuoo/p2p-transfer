import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Token verification result. Deliberately splits "missing / not found / expired / revoked" into distinct codes:
 * collapsing them into one TOKEN_EXPIRED leaves users unsure whether to re-copy the token or ask admin to re-issue.
 */
export type TokenCheck =
  | { ok: true; room: string; expiresAt: number; tokenId: string }
  | { ok: false; code: 'TOKEN_UNKNOWN' | 'TOKEN_EXPIRED' | 'TOKEN_REVOKED' };

export class TokenStore {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS access_tokens (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, room_id TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0)');
  }
  issue(days: number) {
    const token = randomBytes(16).toString('base64url');
    const room = `r_${randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + days * 86400000;
    this.db.prepare('INSERT INTO access_tokens VALUES(?,?,?,?,?,?,NULL,NULL,0)').run(randomBytes(12).toString('hex'), this.hash(token), room, expiresAt, 'active', now);
    return { token, room, expiresAt };
  }
  /** Not-found ≠ expired ≠ revoked: **do not** pre-filter by status='active' in SQL, or the three collapse into one message. */
  resolve(token: string): TokenCheck {
    const r = this.db.prepare('SELECT id,room_id,expires_at,status FROM access_tokens WHERE token_hash=?').get(this.hash(token)) as
      | { id: string; room_id: string; expires_at: number; status: string }
      | undefined;
    if (!r) return { ok: false, code: 'TOKEN_UNKNOWN' };
    if (r.status !== 'active') return { ok: false, code: 'TOKEN_REVOKED' };
    if (r.expires_at < Date.now()) {
      this.db.prepare("UPDATE access_tokens SET status='expired' WHERE id=?").run(r.id);
      return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    this.db.prepare('UPDATE access_tokens SET last_used_at=?,use_count=use_count+1 WHERE id=?').run(Date.now(), r.id);
    return { ok: true, room: r.room_id, expiresAt: r.expires_at, tokenId: r.id };
  }
  /**
   * List token records. **Never returns token_hash**: it is verification material, useless to admins and a gift to offline brute-force if leaked.
   * Refresh expired ones to expired before listing — expiry was otherwise only flipped passively inside resolve(); without this, ?status=active would count them in.
   */
  list(status?: string) {
    this.db.prepare("UPDATE access_tokens SET status='expired' WHERE status='active' AND expires_at<?").run(Date.now());
    const rows = this.db.prepare('SELECT id,room_id,expires_at,status,created_at,revoked_at,last_used_at,use_count FROM access_tokens ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows
      .map(r => ({ id: r.id, room: r.room_id, expiresAt: r.expires_at, status: r.status, createdAt: r.created_at, revokedAt: r.revoked_at ?? null, lastUsedAt: r.last_used_at ?? null, useCount: r.use_count }))
      .filter(r => !status || r.status === status);
  }
  /**
   * Revoke a token (by id or by plaintext). Only updates rows with status='active': re-revoking an already-revoked/expired one is meaningless,
   * returning false lets the caller distinguish "revoked successfully" from "was never active".
   */
  revoke(target: { id: string } | { token: string }) {
    const now = Date.now();
    const result = 'id' in target
      ? this.db.prepare("UPDATE access_tokens SET status='revoked',revoked_at=? WHERE id=? AND status='active'").run(now, target.id)
      : this.db.prepare("UPDATE access_tokens SET status='revoked',revoked_at=? WHERE token_hash=? AND status='active'").run(now, this.hash(target.token));
    return Number(result.changes) > 0;
  }
  private hash(v: string) {
    return createHash('sha256').update(v).digest('hex');
  }
}

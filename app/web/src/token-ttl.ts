// Access-token validity display: the server sends tokenExpiresAt (epoch ms) in welcome,
// and this only does the pure "timestamp → text" computation, so it can be regression-tested directly with node --test.
//
// Three source semantics (keep them distinct, don't collapse into one):
//   number    → has an expiry; show a countdown
//   null      → the server explicitly says "no validity period" (static-secret / token-less)
//   undefined → still unknown (not connected, or the peer is an old server that doesn't send this field)

export type TtlLevel = "ok" | "warn" | "expired" | "permanent" | "unknown";

export interface TtlView {
  /** "Remaining 1d 03:24:15" / "Expired" / "Permanent" / "—" */
  text: string;
  level: TtlLevel;
  /** Hover hint: the exact expiry moment (local time, to the second) */
  title: string;
}

/** Start color-warning when less than 10 minutes remain. */
export const TTL_WARN_MS = 10 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local time "2026-09-20 19:46:23", to the second. */
export function formatAbsolute(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Remaining ms → "2d 03:24:15" / "03:24:15", to the second (floor, no rounding). */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const clock = `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  const days = Math.floor(total / 86400);
  return days ? `${days}天 ${clock}` : clock;
}

export function tokenTtl(expiresAt: number | null | undefined, now: number): TtlView {
  if (expiresAt === undefined) return { text: "—", level: "unknown", title: "尚未从信令服务获得口令有效期" };
  if (expiresAt === null) return { text: "长期有效", level: "permanent", title: "当前信令服务未启用有效期口令" };
  const deadline = formatAbsolute(expiresAt);
  const left = expiresAt - now;
  if (left <= 0)
    return {
      text: "已过期",
      level: "expired",
      title: `口令有效期至 ${deadline}，已过期。当前连接不受影响，重新连接需更换口令`,
    };
  return {
    text: `剩余 ${formatRemaining(left)}`,
    level: left <= TTL_WARN_MS ? "warn" : "ok",
    title: `口令有效期至 ${deadline}`,
  };
}

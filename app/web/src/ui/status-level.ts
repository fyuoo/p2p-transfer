// Top-bar status severity judgment —— serves only the "connection anomaly banner".
//
// Why a separate module: store.statusText is a **severity-free free-form string** (20+ set sites,
// mixing "signaling connected" / "signaling dropped, reconnecting" / "access token invalid"), and the UI can't derive a color from the text.
// The judgment is centralized here; both the desktop main.ts and the mobile mobile.ts share the same rules, avoiding two separate regex sets.
//
// ⚠️ Division of labor (don't mix):
//   Top-bar pill color  ← engine facts like isConnected()/connecting (pillState), never parse the text;
//                         the text may lag real connection state, and coloring from it would lie.
//   Banner show/color   ← statusText severity (statusLevel), only shown when there's a "why" to explain.
import { AUTH_TEXT_PREFIX } from "../reason-labels";

export type StatusLevel = "error" | "warn" | "ok" | "idle";

// Failures that won't self-heal: retries are useless; the user must act (renew token / fix address / check network).
const ERROR_RE = /失败|超时|异常|不可用|无效|不正确|已过期|已撤销|无法|不兼容|非法|不是安全|信令服务未连接/;
// Self-healing: signaling dropped but will auto-reconnect, and established transfers are unaffected —— an orange bar suffices, don't use red.
const WARN_RE = /正在重连|信令断开/;
// Peer availability: not "retries useless" but "peer left" —— goes to warn (orange).
// Must be tested before ERROR_RE: this text contains "failed / unavailable", otherwise it would be judged red,
// misleading the user into renewing the token or fixing the address (when they just need to wait for the peer to come back).
const PEER_GONE_RE = /不在线|暂不可用|已离线|已下线/;
// In progress: normal feedback after the user initiates a connection; a banner would flash on every connect, so it goes to idle.
const BUSY_RE = /正在连接|连接中|正在|重连中/;
const OK_RE = /已连接|已重连/;

export function statusLevel(text: string): StatusLevel {
  const s = (text ?? "").trim();
  if (!s) return "idle";
  // Auth-class text always starts with AUTH_TEXT_PREFIX (the cross-file convention in reason-labels.ts, guarded by npm run test:auth).
  // Checked first: this text may embed neutral words like "retry", so deciding it up front is cleanest.
  if (s.startsWith(AUTH_TEXT_PREFIX)) return "error";
  if (WARN_RE.test(s)) return "warn";
  if (PEER_GONE_RE.test(s)) return "warn";
  if (ERROR_RE.test(s)) return "error";
  if (BUSY_RE.test(s)) return "idle";
  if (OK_RE.test(s)) return "ok";
  // Remaining "disconnected" cases ("peer disconnected" / "connection disconnected"): just warn, don't decide as terminal
  if (s.includes("断开")) return "warn";
  return "idle";
}

/** Top-bar pill three states: decided only by engine facts, never by parsing text. */
export type PillState = "ok" | "busy" | "off";

export function pillState(connected: boolean, connecting: boolean): PillState {
  if (connecting) return "busy"; // Connecting takes priority: during reconnect both can briefly hold, and it shouldn't show "connected" then
  return connected ? "ok" : "off";
}

/** Pill text: only short words —— a long sentence would stretch the top bar and get ellipsis-truncated on narrow screens (an old mobile implementation problem). */
export const PILL_TEXT: Record<PillState, string> = {
  ok: "已连接",
  busy: "连接中…",
  off: "未连接",
};

/** Whether to push a banner below the top bar: only error/warn need it; ok/idle take no space. */
export function bannerVisible(level: StatusLevel): boolean {
  return level === "error" || level === "warn";
}

/** Banner auto-dismiss timeout (ms). It once didn't exist: a "signaling request failed" would hang on the page forever, even after the task ended. */
export const BANNER_TTL_MS = 15000;

/** Banner timeout: 0=hidden; null=persistent; >0=auto-dismiss after ms.
 *  Auth-class is persistent —— that kind is retry-useless and requires user action (renew token / fix address); dismissing it hides the reason. */
export function bannerTtlMs(text: string): number | null {
  if (!bannerVisible(statusLevel(text))) return 0;
  return (text ?? "").trim().startsWith(AUTH_TEXT_PREFIX) ? null : BANNER_TTL_MS;
}

/**
 * How long the banner should still show: 0=hidden/expired, null=persistent, >0=still showing (the render layer hangs a timer on this).
 * at takes store.statusAt (the moment statusText **changed**, not the render moment) —— using the render moment would re-energize on every repaint.
 */
export function bannerRemainMs(text: string, at: number, now: number): number | null {
  const ttl = bannerTtlMs(text);
  if (ttl === 0) return 0;
  if (ttl === null) return null;
  return Math.max(0, at + ttl - now);
}

// Server welcome.ice → RTCConfiguration fragment.
// This only handles two things that are easy to get wrong; everything else is left to the constructor:
// STUN/TURN and policy are all configured by ops in signaling.config.json, and the front end makes no choices.

/**
 * iceTransportPolicy only honors 'relay'; everything else (missing field, old server, typo'd value) falls back to 'all'.
 * Treating an unknown value as relay would cut off all non-TURN users, so err on the conservative side.
 */
export function iceTransportPolicyOf(raw: unknown): RTCIceTransportPolicy {
  return raw === 'relay' ? 'relay' : 'all';
}

/** servers is only adopted when it is an array; otherwise returns undefined and the caller keeps its existing config (old servers don't carry this field). */
export function iceServersOf(raw: unknown): RTCIceServer[] | undefined {
  const servers = (raw as { servers?: unknown } | null | undefined)?.servers;
  return Array.isArray(servers) ? (servers as RTCIceServer[]) : undefined;
}

/**
 * iceTrickle only honors an explicit close: false / 'false' / 0 / '0' fall back to non-trickle (wait for gathering before sending SDP);
 * a missing field, an old server, or any other value is treated as enabled — trickle is the safer default
 * (when TURN allocation doesn't settle, non-trickle stalls the connection).
 */
export function iceTrickleOf(raw: unknown): boolean {
  return raw !== false && raw !== 'false' && raw !== 0 && raw !== '0';
}

// STUN probe: from any machine, verify that a STUN server is actually reachable and returns a public mapped address.
//
// Why this is needed: cross-network P2P depends on STUN for srflx candidates; without them the
// RTCPeerConnection reaches `failed`, which the UI shows as "connection failed + task stuck waiting".
// The two most common deployment pitfalls are
//   (a) signaling.config.json still ships the template's stun.l.google.com (unreachable in this region)
//   (b) coturn isn't running / the cloud firewall and ufw haven't opened 3478/udp
// Both look like "connection failed" but require completely different fixes — this script tells them apart first.
//
// Usage:
//   node scripts/check-stun.mjs                       # probe stun:stun.l.google.com:19302 by default
//   node scripts/check-stun.mjs stun:1.2.3.4:3478     # probe a specific address
//   node scripts/check-stun.mjs stun:stun.l.google.com:19302
//
// Exit code: 0 = Binding Success received; 1 = timeout/no response (UDP blocked or service down).
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

const MAGIC_COOKIE = 0x2112a442;

export function parseTarget(raw) {
  const s = String(raw || '').replace(/^stun:/i, '');
  const [host, port = '3478'] = s.split(':');
  if (!host) throw new Error(`无法解析 STUN 地址：${raw}（示例 stun:1.2.3.4:3478）`);
  return { host, port: Number(port) };
}

// A minimal usable Binding Request (type 0x0001, length 0, carrying only the magic cookie + transaction id).
export function bindingRequest(txid = randomBytes(12)) {
  return Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from([0x21, 0x12, 0xa4, 0x42]), txid]);
}

// Parse XOR-MAPPED-ADDRESS(0x0020) / MAPPED-ADDRESS(0x0001) from the response.
export function parseResponse(buf) {
  const out = { type: buf.readUInt16BE(0), mapped: null, address: null };
  if (out.type !== 0x0101) return out;
  let p = 20;
  while (p + 4 <= buf.length) {
    const attr = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    const v = buf.subarray(p + 4, p + 4 + len);
    if ((attr === 0x0020 || attr === 0x0001) && len >= 8 && v[1] === 0x01) {
      const port = attr === 0x0020 ? v.readUInt16BE(2) ^ (MAGIC_COOKIE >> 16) : v.readUInt16BE(2);
      const ip = attr === 0x0020 ? [v[4] ^ 0x21, v[5] ^ 0x12, v[6] ^ 0xa4, v[7] ^ 0x42] : [v[4], v[5], v[6], v[7]];
      if (attr === 0x0020) out.mapped = `${ip.join('.')}:${port}`;
      else out.address = `${ip.join('.')}:${port}`;
    }
    p += 4 + len + ((4 - (len % 4)) % 4);
  }
  return out;
}

export function probe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const txid = randomBytes(12);
    const done = (r) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);
    socket.on('message', (buf) => {
      const parsed = parseResponse(buf);
      done(parsed.type === 0x0101 ? { ok: true, ...parsed } : { ok: false, error: `unexpected type 0x${parsed.type.toString(16)}` });
    });
    socket.on('error', (e) => done({ ok: false, error: e.message }));
    socket.send(bindingRequest(txid), port, host);
  });
}

const isMain =
  process.argv[1] &&
  decodeURI(import.meta.url)
    .replace(/^file:\/+/i, '')
    .replace(/\\/g, '/')
    .endsWith((process.argv[1] || '').replace(/\\/g, '/'));

if (isMain) {
  const target = parseTarget(process.argv[2] || 'stun:stun.l.google.com:19302');
  const result = await probe(target.host, target.port);
  if (result.ok) {
    console.log(`✅ STUN 可达：${target.host}:${target.port} → 本机公网映射 ${result.mapped ?? result.address}`);
    console.log('   （注意：这里测的是「本机到 STUN」的通路；对端设备需各自再测一次）');
  } else {
    console.log(`❌ STUN 无响应：${target.host}:${target.port}（${result.error}）`);
    console.log('   逐一检查：coturn 是否在跑（ss -lunp | grep 3478）、云防火墙与 ufw 是否放通 3478/udp、地址是否写错。');
  }
  process.exit(result.ok ? 0 : 1);
}

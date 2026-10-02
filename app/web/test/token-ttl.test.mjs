// Regression tests for access-token expiry display (token-ttl.ts).
//
// The easiest thing to get wrong here isn't formatting, but **three source semantics collapsed
// into one**:
//   number    → has an expiry, count down
//   null      → server explicitly says "no expiry token enabled"
//   undefined → not yet known (not connected / legacy server welcome lacks this field)
// Confusing null and undefined yields a false promise like "long-term valid while disconnected".
//
// Run: npm run test:ttl
import { build } from 'esbuild';
import test from 'node:test';
import assert from 'node:assert/strict';

const result = await build({
  stdin: { contents: `export * from './src/token-ttl.ts';`, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

const NOW = 1_700_000_000_000; // fixed baseline; tests are independent of real time

test('Remaining time is accurate to the second and floors (no over-reporting)', () => {
  assert.equal(mod.formatRemaining(0), '00:00:00');
  assert.equal(mod.formatRemaining(999), '00:00:00');
  assert.equal(mod.formatRemaining(1_000), '00:00:01');
  assert.equal(mod.formatRemaining(59_999), '00:00:59');
  assert.equal(mod.formatRemaining(60_000), '00:01:00');
  assert.equal(mod.formatRemaining(3_661_000), '01:01:01');
  assert.equal(mod.formatRemaining(86_400_000), '1天 00:00:00');
  assert.equal(mod.formatRemaining(90_061_000), '1天 01:01:01');
  assert.equal(mod.formatRemaining(7 * 86_400_000 - 1_000), '6天 23:59:59');
});

test('Expired / negative values clamp to zero, no minus sign', () => {
  assert.equal(mod.formatRemaining(-1), '00:00:00');
  assert.equal(mod.formatRemaining(-86_400_000), '00:00:00');
});

test('Unknown (not connected or legacy server): show placeholder, no false "long-term valid"', () => {
  const view = mod.tokenTtl(undefined, NOW);
  assert.equal(view.text, '—');
  assert.equal(view.level, 'unknown');
});

test('Server explicitly disables expiry: show long-term valid', () => {
  const view = mod.tokenTtl(null, NOW);
  assert.equal(view.text, '长期有效');
  assert.equal(view.level, 'permanent');
});

test('Has an expiry: countdown + show the exact expiry moment', () => {
  const expiresAt = NOW + 2 * 86_400_000 + 3 * 3_600_000 + 24 * 60_000 + 15_000;
  const view = mod.tokenTtl(expiresAt, NOW);
  assert.equal(view.text, '剩余 2天 03:24:15');
  assert.equal(view.level, 'ok');
  assert.equal(view.title, `口令有效期至 ${mod.formatAbsolute(expiresAt)}`);
  // Exact moment to the second (local time, YYYY-MM-DD HH:mm:ss)
  assert.match(view.title, /口令有效期至 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('Under 10 minutes remaining enters the warn tier (exactly 10 min still warns)', () => {
  assert.equal(mod.tokenTtl(NOW + 10 * 60_000, NOW).level, 'warn');
  assert.equal(mod.tokenTtl(NOW + 10 * 60_000 + 1, NOW).level, 'ok');
  assert.equal(mod.tokenTtl(NOW + 1, NOW).level, 'warn');
});

test('At or past expiry counts as expired and notes the current connection is unaffected', () => {
  for (const at of [NOW, NOW - 1, NOW - 86_400_000]) {
    const view = mod.tokenTtl(at, NOW);
    assert.equal(view.text, '已过期');
    assert.equal(view.level, 'expired');
    assert.match(view.title, /重新连接需更换口令/);
  }
});

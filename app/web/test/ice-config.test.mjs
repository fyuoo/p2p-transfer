// Regression tests for welcome.ice parsing.
//
// Guards against one misclassification direction: **an unknown iceTransportPolicy must never
// be treated as relay** ——
// a single typo (or wrong casing) would cut off all non-TURN users (only relay candidates
// remain connectable),
// surfacing as "suddenly nothing connects" in the field — extremely hard to diagnose.
// The other direction: when servers is not an array, the original config must be preserved
// rather than iceServers being emptied.
//
// Run: npm run test:ice
import { build } from 'esbuild';
import test from 'node:test';
import assert from 'node:assert/strict';

const result = await build({
  stdin: { contents: `export * from './src/webrtc/ice-config.ts';`, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('Only explicit relay forces relaying', () => {
  assert.equal(mod.iceTransportPolicyOf('relay'), 'relay');
  assert.equal(mod.iceTransportPolicyOf('all'), 'all');
});

test('Missing / malformed / wrong-case values all fall back to all', () => {
  for (const bad of [undefined, null, '', 'RELAY', 'Relay', 'relay ', 'relay-only', 0, 1, {}, [], true]) {
    assert.equal(mod.iceTransportPolicyOf(bad), 'all', `iceTransportPolicy=${JSON.stringify(bad)} must not be treated as relay`);
  }
});

test('servers is adopted only if it is an array, else undefined (caller keeps original config)', () => {
  assert.equal(mod.iceServersOf(undefined), undefined);
  assert.equal(mod.iceServersOf({}), undefined);
  assert.equal(mod.iceServersOf({ servers: null }), undefined);
  assert.equal(mod.iceServersOf({ servers: 'stun:1.2.3.4:3478' }), undefined);
});

test('Credentials and multiple urls within a group are delivered verbatim to PeerConnection', () => {
  const servers = [
    { urls: ['stun:1.2.3.4:3478', 'stun:5.6.7.8:3478'] },
    { urls: ['turn:1.2.3.4:3478?transport=udp'], username: 'u', credential: 'p' },
  ];
  assert.deepEqual(mod.iceServersOf({ servers }), servers);
  assert.deepEqual(mod.iceServersOf({ servers: [] }), [], 'empty array is a valid push (server genuinely has none), not "field missing"');
});

test('iceTrickle defaults on, only an explicit off is honored', () => {
  // On (including missing / legacy-server / invalid values) — trickle is the safer default,
  // avoiding a stuck connection when TURN allocation never settles.
  for (const on of [undefined, null, true, 'true', 1, '1', {}, 'relay', 'all']) {
    assert.equal(mod.iceTrickleOf(on), true, `iceTrickle=${JSON.stringify(on)} should be on`);
  }
  // Off: only an explicit false / 'false' / 0 / '0'.
  for (const off of [false, 'false', 0, '0']) {
    assert.equal(mod.iceTrickleOf(off), false, `iceTrickle=${JSON.stringify(off)} should be off`);
  }
});

// Consistency tests for access-token / auth error-code copy.
//
// Why it's worth guarding separately: `app-engine.onStatus` judges "no more reconnect" for a
// token rejection **by copy prefix** (prefix rather than a state machine,
// because Signaling::onStatus only passes a string). If an auth message no longer starts with
// "访问口令", the symptom is "the connection-timeout hint overrides the real reason",
// which is nearly impossible to diagnose in the field — so this test pins the cross-file convention.
//
// Run: npm run test:auth
import { build } from 'esbuild';
import test from 'node:test';
import assert from 'node:assert/strict';

const result = await build({
  stdin: { contents: `export * from './src/reason-labels.ts';`, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('All auth-code copy starts with the agreed prefix (app-engine uses it to detect "no reconnect")', () => {
  assert.equal(mod.AUTH_TEXT_PREFIX, '访问口令');
  assert.ok(mod.AUTH_ERROR_CODES.length >= 7);
  for (const code of mod.AUTH_ERROR_CODES) {
    const label = mod.REASON_LABELS[code];
    assert.ok(label, `${code} is missing its label`);
    assert.ok(label.startsWith(mod.AUTH_TEXT_PREFIX), `${code} copy must start with "${mod.AUTH_TEXT_PREFIX}", actual: ${label}`);
  }
});

test('The four easily-confused token failures must give distinct hints (classification must guide user action)', () => {
  const texts = ['TOKEN_REQUIRED', 'TOKEN_UNKNOWN', 'TOKEN_EXPIRED', 'TOKEN_REVOKED'].map(mod.reasonLabel);
  assert.equal(new Set(texts).size, 4, 'unfilled/invalid/expired/revoked must not collapse into one phrase');
  assert.match(mod.reasonLabel('TOKEN_UNKNOWN'), /复制完整/, 'user who mis-copied should be told to re-copy');
  assert.match(mod.reasonLabel('TOKEN_REVOKED'), /管理员/, 'revoked user can only contact an admin');
});

test('reasonLabel exact match takes priority over substring match (long codes are not hijacked by short ones)', () => {
  assert.equal(mod.reasonLabel('TOKEN_EXPIRED_WHILE_CONNECTED'), mod.REASON_LABELS.TOKEN_EXPIRED_WHILE_CONNECTED);
  assert.match(mod.reasonLabel('TOKEN_EXPIRED_WHILE_CONNECTED'), /连接已断开/);
  assert.equal(mod.reasonLabel('Error: TOKEN_REQUIRED'), mod.REASON_LABELS.TOKEN_REQUIRED);
  // The "kicked on expiry" case must say "reconnect requires a new token", otherwise users
  // think it's a network issue and keep retrying
  assert.match(mod.reasonLabel('TOKEN_EXPIRED_WHILE_CONNECTED'), /重新连接需更换口令/);
});

test('Direct-connect failure copy must also be localized (task-card note outputs reasonLabel directly)', () => {
  // These two are shown as task-card notes (failPeerTasks / watchPeerConnection),
  // and missing the mapping would surface bare English codes like ICE_FAILED / connection-timeout
  // on the card.
  for (const code of ['ICE_FAILED', 'CONN_TIMEOUT']) {
    const label = mod.reasonLabel(code);
    assert.equal(label, mod.REASON_LABELS[code], `${code} must hit the label table`);
    assert.ok(!/[A-Za-z_]{4,}/.test(label), `${code} copy must not contain an English code: ${label}`);
  }
  assert.match(mod.reasonLabel('ICE_FAILED'), /直连/, 'direct-connect failure must make clear it cannot reach the peer');
});

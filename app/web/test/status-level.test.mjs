// Regression tests for the top-bar "connection anomaly" decision (src/ui/status-level.ts).
//
// What's guarded here is a division of labor that's easy to break:
//   the top-bar pill color ← decided solely by engine facts (isConnected/connecting),
//   never parsing copy;
//   the banner's appearance ← decided by statusText severity, and normal feedback like
//   "connecting" must not pop up.
// Two costs of getting the direction wrong: classifying normal as error → a banner flashes
// on every connect; classifying error as normal → the user can't see failures.
//
// Run: npm run test:status
import { build } from 'esbuild';
import test from 'node:test';
import assert from 'node:assert/strict';

const result = await build({
  stdin: { contents: "export * from './src/ui/status-level.ts';", resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('胶囊三态只由引擎事实决定，不解析文案', () => {
  assert.equal(mod.pillState(false, false), 'off');
  assert.equal(mod.pillState(true, false), 'ok');
  // Connecting takes priority: during reconnect both briefly hold, and showing "connected"
  // then would be a false promise
  assert.equal(mod.pillState(true, true), 'busy');
  assert.equal(mod.pillState(false, true), 'busy');
  assert.deepEqual(mod.PILL_TEXT, { ok: '已连接', busy: '连接中…', off: '未连接' });
});

test('常态不弹横幅：空串 / 静息「未连接」/ 已连接 / 进行中', () => {
  assert.equal(mod.statusLevel(''), 'idle');
  assert.equal(mod.statusLevel('   '), 'idle');
  assert.equal(mod.statusLevel('未连接'), 'idle'); // resting state, not an error
  assert.equal(mod.statusLevel('信令已连接 · 浏览器传输'), 'ok');
  assert.equal(mod.statusLevel('信令已重连，会话已重建'), 'ok');
  assert.equal(mod.statusLevel('正在连接信令服务…'), 'idle'); // normal feedback after a user action
  assert.equal(mod.statusLevel('连接(笔记本)：连接中'), 'idle');
  assert.equal(mod.statusLevel('请先完成或取消当前任务，再修改信令配置'), 'idle');
  for (const s of ['', '未连接', '正在连接信令服务…', '信令已连接 · 浏览器传输', '连接(笔记本)：连接中']) {
    assert.equal(mod.bannerVisible(mod.statusLevel(s)), false, s);
  }
});

test('信令掉了但会自动重连：warn（橙条），不判死', () => {
  assert.equal(mod.statusLevel('信令断开，正在重连；已建立的传输继续'), 'warn');
  assert.equal(mod.bannerVisible('warn'), true);
  // Same for hints like "peer disconnected" — they only inform
  assert.equal(mod.statusLevel('对端已断开'), 'warn');
});

test('鉴权类错误一律判死（前缀约定，重试无用）', () => {
  for (const s of [
    '访问口令无效（未找到该口令），请检查是否复制完整',
    '访问口令已过期，连接已断开；重新连接需更换口令',
    '访问口令不正确，请核对后重试',
    '访问口令不能为空，请填写后重试',
  ]) {
    assert.equal(mod.statusLevel(s), 'error', s);
    assert.equal(mod.bannerVisible(mod.statusLevel(s)), true, s);
  }
});

test('超时 / 失败 / 异常 / 不安全上下文判为 error 并弹横幅', () => {
  for (const s of [
    '信令连接超时，请检查地址或口令后重试',
    '接收失败：连接已断开',
    '本地已取消，但通知对端失败：信令服务响应超时',
    '信令服务未连接',
    '当前地址不是安全上下文，浏览器不提供 SHA-256；请改用 HTTPS，或把诊断模式切到「网络」',
  ]) {
    assert.equal(mod.statusLevel(s), 'error', s);
    assert.equal(mod.bannerVisible(mod.statusLevel(s)), true, s);
  }
});

test('未知文案不误报：归 idle，不弹横幅', () => {
  assert.equal(mod.statusLevel('随便一句没人认识的话'), 'idle');
  assert.equal(mod.bannerVisible('idle'), false);
  assert.equal(mod.bannerVisible('ok'), false);
});

test('对端走了只提醒不判死：PEER_UNAVAILABLE 归 warn（别让用户去改口令）', () => {
  // This is a signaling-layer error packet (PEER_UNAVAILABLE), not a data-channel failure;
  // its meaning is "peer left"; retrying is useless and no user action is needed — flagging
  // it red would mislead into checking address/token.
  assert.equal(mod.statusLevel('信令请求失败：对方不在线或暂不可用'), 'warn');
  assert.equal(mod.bannerVisible('warn'), true);
});

test('横幅会自动收起：非鉴权类到时即走，鉴权类常驻（重试无用，必须用户动手）', () => {
  const transient = '信令请求失败：对方不在线或暂不可用';
  assert.equal(mod.bannerTtlMs(transient), mod.BANNER_TTL_MS);
  assert.equal(mod.bannerRemainMs(transient, 1000, 1000), mod.BANNER_TTL_MS);
  assert.equal(mod.bannerRemainMs(transient, 1000, 1000 + mod.BANNER_TTL_MS), 0); // dismisses at expiry
  assert.equal(mod.bannerRemainMs(transient, 1000, 999999), 0); // long expired
  const auth = '访问口令无效（未找到该口令），请检查是否复制完整';
  assert.equal(mod.bannerTtlMs(auth), null); // persistent
  assert.equal(mod.bannerRemainMs(auth, 1000, 999999), null);
  // Always 0 in the normal case: the render layer uses this to skip timers and avoid layout space
  assert.equal(mod.bannerTtlMs('未连接'), 0);
  assert.equal(mod.bannerRemainMs('信令已连接 · 浏览器传输', 1000, 1000), 0);
});

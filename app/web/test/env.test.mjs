// Regression tests for environment detection (device form factor / in-app browsers /
// receive-save method).
//
// Guards against two misclassification classes:
//   1. **False positive** on QQ Browser (a standalone app that downloads fine) — its UA also
//      contains MQQBrowser; only QQ's in-app browser
//      additionally carries `QQ/8.x.x`. A wrong call would push download-capable users to
//      switch browsers.
//   2. **False negative** on WeChat/QQ in-app browsers — failure to detect means the user
//      wastes a whole transfer (pure P2P has no server-side fallback,
//      and discovering the file can't be saved only after it's fully received voids the round).
//
// Run: npm run test:env
import { build } from 'esbuild';
import test from 'node:test';
import assert from 'node:assert/strict';

const result = await build({
  stdin: { contents: `export * from './src/env.ts';`, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

const PC_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; PJD110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';
const WECHAT_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN';
const WECHAT_ANDROID = 'Mozilla/5.0 (Linux; Android 14; PJD110; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600(0x2800313D) Weixin NetType/WIFI Language/zh_CN';
const QQ_IN_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MQQBrowser/6.8 Mobile Safari/537.36 QQ/8.9.88.611 V1_IPH_SQ_8.9.88_1_APP_A NetType/WIFI QBWebViewType/1';
// QQ Browser (standalone app, **can** download normally): contains MQQBrowser but not QQ/version
const QQ_BROWSER = 'Mozilla/5.0 (Linux; Android 14; PJD110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 MQQBrowser/12.6';

const envOf = (ua, o = {}) => mod.describeEnv(ua, { canSaveToFolder: o.canSaveToFolder ?? false, maxTouchPoints: o.touch ?? 0 });

test('PC Chromium: no prompt when a folder can be picked', () => {
  const e = envOf(PC_CHROME, { canSaveToFolder: true });
  assert.equal(e.canSaveToFolder, true);
  assert.equal(e.showBanner, false);
  assert.equal(e.hint, '');
  assert.equal(e.blockedReceive, false);
});

test('PC browser without File System API: prompt falls back to the default download dir', () => {
  const e = envOf(PC_CHROME);
  assert.equal(e.mobile, false);
  assert.equal(e.showBanner, true);
  assert.equal(e.blockedReceive, false);
  assert.match(e.hint, /默认下载目录/);
});

test('iPhone Safari: direct the user to the Files app download', () => {
  const e = envOf(IPHONE_SAFARI);
  assert.equal(e.mobile, true);
  assert.match(e.hint, /「文件」App/);
});

test('Android Chrome: direct the user to the Files/Downloads folder', () => {
  const e = envOf(ANDROID_CHROME);
  assert.equal(e.mobile, true);
  assert.match(e.hint, /「文件管理」App/);
});

test('WeChat in-app browser (iOS / Android) is judged unable to save received files', () => {
  for (const ua of [WECHAT_IOS, WECHAT_ANDROID]) {
    const e = envOf(ua);
    assert.equal(e.inApp, 'wechat');
    assert.equal(e.inAppLabel, '微信');
    assert.equal(e.blockedReceive, true);
    assert.equal(e.showBanner, true);
    assert.match(e.hint, /微信内置浏览器/);
    assert.match(e.hint, /在浏览器打开/);
  }
});

test('QQ in-app browser is judged unable to save received files', () => {
  const e = envOf(QQ_IN_APP);
  assert.equal(e.inApp, 'qq');
  assert.equal(e.blockedReceive, true);
  assert.match(e.hint, /QQ内置浏览器/);
});

test('QQ Browser (standalone app) must not be misclassified — it downloads fine', () => {
  const e = envOf(QQ_BROWSER);
  assert.equal(e.inApp, null);
  assert.equal(e.blockedReceive, false);
  assert.match(e.hint, /「文件管理」App/); // Hint still says where to save, but doesn't push to switch browsers
});

test('iPadOS desktop mode identified by touch points (same UA as Mac is not a phone)', () => {
  assert.equal(envOf(IPAD_DESKTOP_UA, { touch: 5 }).mobile, true);
  assert.match(envOf(IPAD_DESKTOP_UA, { touch: 5 }).hint, /「文件」App/);
  assert.equal(envOf(IPAD_DESKTOP_UA, { touch: 0 }).mobile, false);
});

test('Capability judgment does not depend on UA: under the same UA, canSaveToFolder decides the prompt', () => {
  // Mobile UA but env claims a directory picker (e.g. a future WebView implementing FSA) →
  // no hint, go straight to folder selection
  const e = envOf(IPHONE_SAFARI, { canSaveToFolder: true });
  assert.equal(e.showBanner, false);
  assert.equal(e.hint, '');
});

test('Node environment without window: canSaveToFolder is false', () => {
  assert.equal(mod.canSaveToFolder(), false);
});

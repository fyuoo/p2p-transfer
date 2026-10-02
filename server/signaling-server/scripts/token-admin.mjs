#!/usr/bin/env node
/**
 * P2P access-token management CLI: issue / list / revoke / health check.
 *
 * Zero-dependency single file — uses only Node built-ins, so it can be copied onto any
 * machine with Node >= 22 and run directly, with no npm install and no other repo parts.
 *
 * When the service is deployed remotely (not on this host): first reverse-proxy /admin/*
 * in Caddy (DEPLOY.md §1.3), then point at it with --url https://<public-ip>.
 *
 * ⚠️ The admin secret (--admin-token / --admin-token-file) and the "access token" (the
 * string issued and handed to end users) are two different things — don't confuse them:
 * the former is the operator's credential, the latter is the entry ticket for end users.
 */
import { readFileSync } from 'node:fs';

const HELP = [
  'P2P 访问口令管理（签发 / 列表 / 撤销 / 探活）',
  '',
  '用法：',
  '  token-admin.mjs issue [--days 3]          签发访问口令（默认 1 天，上限 7 天）',
  '  token-admin.mjs list [--status active]    列出口令（active|expired|revoked，缺省全部）',
  '  token-admin.mjs revoke --id <id>          撤销口令（--id 或 --token 二选一；什么都没改到退出码为 1）',
  '  token-admin.mjs health                    探活信令服务（无需管理口令）',
  '',
  '连接参数（也可用环境变量 SIG_ADMIN_URL / SIG_ADMIN_TOKEN）：',
  '  --url <地址>              服务地址，缺省 http://127.0.0.1:8787；不带协议头按 https:// 处理',
  '  --admin-token <口令>      管理口令（注意会进 shell 历史）',
  '  --admin-token-file <路径> 从文件读管理口令（推荐）',
  '  --config <路径>           从 JSON 读 { url, adminToken }',
  '  --insecure                跳过 TLS 证书校验（自签证书 / 临时调试）',
  '  --json                    只输出 JSON，便于脚本消费',
  '  -h, --help                显示本帮助',
].join('\n');

function die(message, code = 1) { console.error(message); process.exit(code); }

const argv = process.argv.slice(2);
const flags = new Map();
const args = [];
for (let i = 0; i < argv.length; i += 1) {
  const item = argv[i];
  if (item === '-h' || item === '--help') { flags.set('help', true); continue; }
  if (!item.startsWith('--')) { args.push(item); continue; }
  const eq = item.indexOf('=');
  if (eq >= 0) { flags.set(item.slice(2, eq), item.slice(eq + 1)); continue; }
  const key = item.slice(2);
  const next = argv[i + 1];
  // Missing-value detection: when the next token is another flag, treat this flag as valueless, so --json isn't swallowed as the value of --days
  if (next === undefined || next.startsWith('--')) { flags.set(key, true); continue; }
  flags.set(key, next);
  i += 1;
}

/** Read a valued flag. If `--days` is given without a value, fail loudly rather than silently becoming true and falling through to the default branch. */
function str(name) {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return die('--' + name + ' 需要一个值', 2);
  return value;
}

const configPath = str('config');
let config = {};
if (configPath) {
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch (error) { die('读取 --config 失败（' + configPath + '）：' + error.message, 2); }
}

const command = flags.get('help') ? 'help' : args[0] || 'help';
if (command === 'help') { console.log(HELP); process.exit(0); }

const rawUrl = str('url') || config.url || process.env.SIG_ADMIN_URL || 'http://127.0.0.1:' + (process.env.SIG_PORT || '8787');
// Treat a URL without a scheme as https: the primary scenario is connecting from this host to a public service.
let base = rawUrl.includes('://') ? rawUrl : 'https://' + rawUrl;
while (base.endsWith('/')) base = base.slice(0, -1);

if (flags.get('insecure')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.error('注意：--insecure 已跳过 TLS 证书校验，仅用于自签证书或临时调试。');
}

function adminToken() {
  const direct = str('admin-token') || config.adminToken || process.env.SIG_ADMIN_TOKEN;
  if (direct) return direct;
  const tokenFile = str('admin-token-file') || config.adminTokenFile;
  if (tokenFile) {
    try { return readFileSync(tokenFile, 'utf8').trim(); }
    catch (error) { return die('读取管理口令文件失败（' + tokenFile + '）：' + error.message, 2); }
  }
  return die('缺少管理口令：用 --admin-token-file <路径>（推荐）/ --admin-token / --config，或设置 SIG_ADMIN_TOKEN', 2);
}

/**
 * Centralize network and protocol error handling. fetch throws an uninformative
 * TypeError('fetch failed'); the real cause lives in error.cause (ECONNREFUSED /
 * untrusted cert / timeout), and surfacing it avoids a wild goose chase.
 */
async function request(method, path, body, auth, tolerate = []) {
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers: auth
        ? { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }
        : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const cause = String((error && error.cause && error.cause.message) || error.message);
    const cert = /certificate|self.signed|unable to verify/i.test(cause);
    return die('请求 ' + base + ' 失败：' + cause + (cert ? '\n  证书不被信任：自签证书可加 --insecure（仅调试）；生产请用受信任的 IP / 域名证书。' : ''));
  }
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch {
    // Most common pitfall: the path got caught by the static site — Caddy only reverse-proxied
    // the ws requests with Upgrade, so `try_files {path} /index.html` turns /admin/tokens into an HTML page.
    const html = text.trimStart().charAt(0) === '<';
    return die(
      '期望 JSON，实际拿到 HTTP ' + response.status + (html
        ? ' 的 HTML 页面。\n  说明 ' + base + ' 的 /admin 没被反代到信令服务：Caddyfile 需要 handle /admin/*（见 DEPLOY.md §1.3）。'
        : '，内容：' + text.slice(0, 200)),
    );
  }
  // tolerate: let an expected non-2xx through for the caller to interpret (e.g. revoking an already-inactive token → 404)
  if (!response.ok && !tolerate.includes(response.status)) return die('服务返回 HTTP ' + response.status + '：' + (payload.error || text.slice(0, 200)));
  return payload;
}

function remaining(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86400), hours = Math.floor((total % 86400) / 3600), minutes = Math.floor((total % 3600) / 60);
  if (days) return days + ' 天 ' + hours + ' 小时';
  if (hours) return hours + ' 小时 ' + minutes + ' 分';
  return minutes + ' 分';
}

if (command === 'issue') {
  const days = Number(str('days') || 1);
  if (!Number.isInteger(days) || days < 1 || days > 7) die('--days 必须是 1 到 7 的整数', 2);
  const issued = await request('POST', '/admin/tokens', { days }, adminToken());
  if (flags.get('json')) console.log(JSON.stringify(issued));
  else {
    console.log('访问口令：' + issued.token);
    console.log('有效期至：' + new Date(issued.expiresAt).toLocaleString());
    console.log('内部传输组：' + issued.room);
  }
} else if (command === 'list') {
  const status = str('status');
  if (status && status !== 'active' && status !== 'expired' && status !== 'revoked') die('--status 只能是 active、expired 或 revoked', 2);
  const result = await request('GET', '/admin/tokens' + (status ? '?status=' + status : ''), undefined, adminToken());
  const tokens = Array.isArray(result.tokens) ? result.tokens : [];
  if (flags.get('json')) console.log(JSON.stringify(result));
  else if (!tokens.length) console.log('（没有符合条件的口令）');
  else {
    for (const item of tokens) {
      const parts = [item.status, '到期 ' + new Date(item.expiresAt).toLocaleString()];
      // For expired / revoked tokens, "remaining time" is meaningless; leaving it blank reads less ambiguously than showing 0 minutes
      if (item.status === 'active') parts.push('剩余 ' + remaining(item.expiresAt - Date.now()));
      if (item.lastUsedAt) parts.push('最后使用 ' + new Date(item.lastUsedAt).toLocaleString());
      if (item.useCount) parts.push('已用 ' + item.useCount + ' 次');
      console.log(parts.join('  |  '));
      console.log('    id=' + item.id + '   组=' + item.room);
    }
  }
} else if (command === 'revoke') {
  const id = str('id');
  const token = str('token');
  if (!id && !token) die('revoke 需要 --id <id> 或 --token <明文口令>', 2);
  const result = await request('POST', '/admin/tokens/revoke', id ? { id } : { token }, adminToken(), [404]);
  if (flags.get('json')) console.log(JSON.stringify(result));
  else if (result.revoked) console.log('已撤销：该口令立即失效（对端下次连接会被拒）。');
  else console.log('未撤销：口令不存在，或已经是过期 / 已撤销状态。');
  // Semantically, "nothing was revoked" must be detectable by a script, but needn't be an alarming error: print an explanation + exit code 1.
  if (!result.revoked) process.exitCode = 1;
} else if (command === 'health') {
  const result = await request('GET', '/healthz');
  if (flags.get('json')) console.log(JSON.stringify(result));
  else console.log('服务正常：在线 ' + result.peers + ' 个连接（' + base + '）。');
} else {
  die('未知子命令：' + command + '\n\n' + HELP, 2);
}

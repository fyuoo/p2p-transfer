# p2p-transfer

可自托管的浏览器间文件传输，基于 WebRTC。

文件通过两个浏览器之间的 WebRTC DataChannel 传输；独立的信令服务只负责握手——房间、在线状态、邀请、SDP 与 ICE candidate。**信令服务不会接收或保存文件内容。**

先说两点最常见的误解：

- **TURN 可能会中转你的数据。** 无法建立直连时，WebRTC 会回退到 TURN 中继，流量将经由该中继转发。但浏览器之间仍是加密的——TURN 只能看到加密数据包和连接元数据，看不到文件内容。
- **部署信令服务不等于具备 NAT 穿透能力。** 它只做信令。跨公网、对称 NAT、企业网络和移动网络通常还需要 STUN/TURN 服务。

[English](README.md) | 简体中文

## 仓库结构

```
app/web/                    TypeScript Web 客户端（桌面 + 移动端入口，Vite）
public/                     共享信令契约（TypeScript，唯一权威）
server/signaling-server/    Node.js 信令服务（房间、口令、管理接口、TURN REST 凭据）
```

`app/web` 是浏览器端与桌面端共用的前端。桌面壳本身（Tauri，`app/windows`）与 webview 适配层（`app/web/src/tauri/`）**不在本仓库内**。

## 快速开始

```bash
# 1) 信令服务
cd server/signaling-server
npm install
cp signaling.config.example.json signaling.config.json   # 按需调整
npm run dev                                               # 监听 ws://127.0.0.1:8787

# 2) Web 客户端
cd app/web
npm install
npm run dev                                               # http://localhost:5173
```

客户端按以下顺序确定信令地址：URL 参数 `?sig=ws://<host>:8787` → `app/web/config/app-config.js`（部署期覆盖，不入库）→ 默认 `ws://localhost:8787`。

**生产环境请使用 HTTPS/WSS。** HTTPS 页面无法建立明文 `ws://` 连接（mixed content 会被拦截），因此信令服务必须通过 `wss://` 访问——通常在其前置一层 TLS 终止（如 Caddy/Nginx）。

## 信令服务看得到什么 / 看不到什么

| 数据 | 信令服务是否可见 |
|---|---|
| 文件内容 | **否** —— 从不接收、从不保存 |
| 文件名、大小、数量 | 是（在传输 manifest 中） |
| 房间、设备名、传输 ID | 是 |
| 连接时间、SDP、ICE candidate | 是 |
| TURN 中继上的文件内容 | **否** —— 只有加密流量与元数据 |

WebRTC 用 DTLS 加密 DataChannel，文件字节在传输中是受保护的。但要注意信任模型：信令服务仍然参与连接协商，且当前**没有带外指纹校验或端到端身份认证**。如果你不信任信令服务的运营方，就自己部署；自建时请保护好管理接口与 TURN 密钥（见 [SECURITY.md](SECURITY.md)）。

## NAT 穿透（STUN/TURN）

- 同一局域网或简单 NAT：host / server-reflexive candidate 通常就够。
- 跨公网、对称 NAT、企业网络、移动运营商网络：几乎一定需要 TURN。
- TURN over UDP 吞吐最好；TCP/TLS 变体以吞吐换取防火墙兼容性。
- 本项目提供兼容 coturn 的 REST 凭据：服务端为每次连接现签短期凭据，长期密钥（`SIG_TURN_SECRET`）永不下发到客户端。

## 浏览器支持与当前限制

- **需要 HTTPS 或 `localhost`**（安全上下文），WebRTC 与大文件下载用到的 OPFS 都依赖它。
- **Safari 无痕模式**下 OPFS 写入可能失败并抛 `UnknownError`。客户端在使用前会**实际写入 1 字节**来探测 OPFS，失败则回退到内存下载，并把它报告为「环境限制」而不是「传输失败」。超大文件可能超出移动端内存上限。
- **移动端浏览器可能挂起后台标签页**，导致进行中的传输停滞。请保持页面在前台。
- **传输是实时的点对点会话**，没有离线收件箱——两端都必须在线。刷新或断连后无法续传，只能重新开始。
- 不支持文件夹/目录传输（只支持平铺的文件列表）。
- 界面文案、管理页和 `token-admin` CLI 输出目前**只有中文**。当前没有 i18n 层（字符串硬编码），要加语言得先把字符串抽出来。

## 访问口令

服务端支持带过期时间的按客户端访问口令，可通过 `/admin/` 管理页签发（需设置 `SIG_ADMIN_TOKEN`），或用零依赖 CLI：

```bash
cd server/signaling-server
SIG_ADMIN_TOKEN=<管理口令> node scripts/token-admin.mjs issue --days 3
```

口令明文只以 SHA-256 哈希形式存储。

## 测试

```bash
cd app/web                  && npm run typecheck && npm run build
cd app/web                  && node --test test/download-writer.test.mjs test/status-level.test.mjs test/auth-labels.test.mjs test/env.test.mjs test/token-ttl.test.mjs test/ice-config.test.mjs
cd server/signaling-server  && npm test          # 服务端用例
```

`npm test` 还会跑一个需要真实浏览器环境的端到端传输用例，不属于命令行可验证集合；建议用上面逐条显式指定 suite 的命令。

## 部署后的入口

`/`（桌面端）、`/mobile.html`（移动端）、`/admin/`（口令管理）、`/healthz`（探活）。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题见 [SECURITY.md](SECURITY.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

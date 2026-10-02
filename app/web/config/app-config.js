// P2P Drop 前端运行配置（开源默认模板，无敏感值）
// 由 index.html / mobile.html 通过 <script src="/app-config.js"> 注入，设置全局 window.P2P_APP_CONFIG。
// Vite 会把它原样复制到构建产物 dist/ 根目录。部署时直接修改 dist/app-config.js，无需重新构建。
// 所有字段可选；未设置时回退到 URL 参数或代码默认值。
window.P2P_APP_CONFIG = {
  signalingUrl: "",   // 留空 -> ?sig= 参数 -> ws://localhost:8787
  defaultRoom: "",    // 留空 -> "token"
  debug: false
};

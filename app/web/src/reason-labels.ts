// Error code / raw error → Chinese label.
// All UI-facing text goes through here, so we never expose raw codes like SIGNAL_OFFLINE / PEER_UNAVAILABLE to the user.
// Kept at src root (not under ui/) because the signaling layer (signaling/) also needs it, avoiding a circular dependency.
export const REASON_LABELS: Record<string, string> = {
  USER_CANCEL: "用户取消",
  USER_REJECT: "对端拒绝接收",
  ACCEPT_TIMEOUT: "等待对端确认超时",
  CONN_TIMEOUT: "连接建立超时",
  CONN_DROPPED: "连接已断开",
  // RTCPeerConnection entered failed (all ICE candidates failed to connect): the two ends cannot reach each other,
  // commonly because there are no srflx candidates (STUN unreachable) or the router behind the same NAT doesn't support hairpinning.
  ICE_FAILED: "无法与对端建立直连，两端网络可能无法互通",
  CANCELLED_OR_DISCONNECTED: "连接已断开",
  CHANNEL_ERROR: "传输通道异常",
  TRANSFER_TIMEOUT: "传输超时（长时间无数据）",
  // Stage-level liveness failures: the peer stopped answering while we were waiting for one specific reply, so the
  // task ends here instead of hanging until the global timeout.
  DISK_STALL: "写入磁盘卡住（磁盘无响应或空间不足），传输已中止",
  CREDIT_STALL: "接收端长时间未回应（可能正在写入磁盘或已离线）",
  COMMIT_STALL: "等待接收端确认落盘超时",
  RESULT_STALL: "等待接收端完成确认超时",
  MANIFEST_STALL: "接收端长时间未就绪",
  PEER_STALL: "对端长时间无响应",
  TRANSFER_MISMATCH: "任务标识不匹配",
  ATTEMPT_MISMATCH: "传输轮次不匹配，请重试",
  SIGNAL_OFFLINE: "信令服务未连接",
  SIGNAL_BUSY: "信令繁忙，请稍后重试",
  SIGNAL_ACK_TIMEOUT: "信令服务响应超时",
  BUSY: "并发任务已达上限",
  CONFLICTING_INVITE: "任务标识冲突",
  VERSION_MISMATCH: "协议版本不兼容",
  BLOCK_SIZE_MISMATCH: "分块大小不匹配",
  MESSAGE_LIMIT_TOO_SMALL: "数据通道帧上限过小",
  CREDIT_EXCEEDED: "流控校验失败",
  RECEIVE_QUEUE_FULL: "接收端处理不及，队列已满",
  // OPFS probe failed or the sandbox rejected the write mid-transfer (Safari Private Browsing and friends):
  // this is a browser-mode limitation, not a transfer failure, so never present it as one.
  OPFS_UNAVAILABLE: "当前浏览器模式不支持直接保存（如 Safari 无痕模式），请退出无痕模式或改用 Chrome / Edge / 桌面端",
  CONTROL_FLOOD: "控制消息过于频繁",
  EARLY_RESULT: "结果确认时序异常",
  DUPLICATE_MANIFEST: "重复的文件清单",
  DUPLICATE_TRANSFER: "重复的任务",
  UNAUTHORIZED_MANIFEST: "文件清单未获授权",
  UNEXPECTED_DATA: "收到非预期的数据帧",
  UNEXPECTED_CONTROL: "收到非预期的控制消息",
  INVALID_FRAME: "数据帧格式非法",
  INVALID_FRAME_SIZE: "帧大小非法",
  INVALID_MANIFEST: "文件清单非法",
  INVALID_FILE: "文件信息非法",
  INVALID_TOTAL_SIZE: "总大小非法",
  INVALID_OFFSET: "偏移量非法",
  INVALID_RANGE: "数据区间非法",
  INVALID_DATA_RANGE: "数据范围非法",
  INVALID_WINDOW: "接收窗口非法",
  INVALID_CREDIT: "额度非法",
  INVALID_COMMIT: "落盘校验失败",
  INVALID_ID: "任务标识非法",
  INVALID_SOURCE: "数据源非法",
  INVALID_TEST_MODE: "测试模式非法",
  MIXED_TEST_MODES: "多个文件测试模式不一致",
  MEMORY_SOURCE_REQUIRES_DISCARD_MODE: "内存数据源只能用于不保存模式",
  SOURCE_CHANGED_OR_SHORT_READ: "源文件已变化或读取不完整",
  MANIFEST_TOO_LARGE: "文件清单过大",
  CONTROL_TOO_LARGE: "控制消息过大",
  UNKNOWN_CONTROL: "未知的控制消息",
  // Error codes returned by the signaling server —— token/auth category (see AUTH_ERROR_CODES below)
  // ⚠️ These **must** start with AUTH_TEXT_PREFIX (app-engine uses the prefix to recognize "will not reconnect").
  TOKEN_EXPIRED_WHILE_CONNECTED: "访问口令已过期，连接已断开；重新连接需更换口令",
  TOKEN_REQUIRED: "访问口令不能为空，请填写后重试",
  TOKEN_UNKNOWN: "访问口令无效（未找到该口令），请检查是否复制完整",
  TOKEN_EXPIRED: "访问口令已过期，请重新获取",
  TOKEN_REVOKED: "访问口令已被撤销，请联系管理员重新签发",
  TOKEN_STORE_UNAVAILABLE: "访问口令服务不可用，请联系管理员",
  UNAUTHORIZED: "访问口令不正确，请核对后重试",
  // Error codes returned by the signaling server —— other
  SESSION_IN_USE: "该设备标识已在其他窗口连接",
  PEER_UNAVAILABLE: "对方不在线或暂不可用",
  PROTOCOL_MISMATCH: "协议不兼容，无法与对方建立连接",
  CROSS_ENGINE_DISABLED: "服务端未开启跨端互传",
  TASK_LIMIT: "任务数量已达上限",
  TASK_FORBIDDEN: "无权操作该任务",
  TASK_NOT_ACCEPTED: "对方尚未接受传输请求",
  INVALID_TRANSFER: "任务标识非法",
  INVALID_FILES: "文件信息非法",
  INVALID_MESSAGE: "信令消息非法",
  INVALID_SDP: "连接描述非法",
  INVALID_BROWSER_SIGNAL: "浏览器信令非法",
  INVALID_NATIVE_SIGNAL: "原生端信令非法",
  TEXT_ONLY: "仅支持文本信令",
  ALREADY_REGISTERED: "重复注册",
  HELLO_REQUIRED: "需先完成信令握手",
  // Browsers don't provide WebCrypto hashing in an insecure (http) context
  CRYPTO_UNAVAILABLE: "当前地址不是安全上下文，浏览器不提供 SHA-256；请改用 HTTPS，或把诊断模式切到「网络」",
};

/**
 * Token/auth error codes: on a hit, "retry would still be rejected" → the client stops auto-reconnecting
 * and reports the reason verbatim to the status bar.
 *
 * ⚠️ These codes' text **must** start with AUTH_TEXT_PREFIX: `app-engine.onStatus` uses that prefix to clear
 * the 15-second connection-timeout timer (otherwise the timeout hint would overwrite this more accurate line). Cross-file
 * contract, enforced by `npm run test:auth` to keep both sides consistent. Changing the prefix requires updating app-engine too.
 */
export const AUTH_TEXT_PREFIX = "访问口令";
export const AUTH_ERROR_CODES: readonly string[] = [
  "TOKEN_REQUIRED",
  "TOKEN_UNKNOWN",
  "TOKEN_EXPIRED",
  "TOKEN_EXPIRED_WHILE_CONNECTED",
  "TOKEN_REVOKED",
  "TOKEN_STORE_UNAVAILABLE",
  "UNAUTHORIZED",
];

// Strip prefixes like Error:/DOMException: before matching Chinese labels; return verbatim if no match (callers usually accept that).
export function reasonLabel(raw: unknown): string {
  let s = String(raw ?? "").trim();
  const prefix = /^(?:Error|DOMException|TypeError|RangeError):\s*/.exec(s);
  if (prefix) s = s.slice(prefix[0].length);
  if (REASON_LABELS[s]) return REASON_LABELS[s];
  for (const code of Object.keys(REASON_LABELS)) if (s.includes(code)) return REASON_LABELS[code];
  return s;
}

// RTCPeerConnectionState → Chinese label
export const PC_STATE_LABELS: Record<string, string> = {
  new: "正在建立",
  connecting: "连接中",
  connected: "已连接",
  disconnected: "连接中断",
  failed: "连接失败",
  closed: "已关闭",
};

// Diagnostic results' sent/recv and running/completed English states → Chinese label
export const DIAG_STATUS_LABELS: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已取消",
};

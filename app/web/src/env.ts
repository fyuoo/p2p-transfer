// Runtime environment detection: device form factor / in-app browser / how received files are saved.
//
// Why this must run on the client: what actually decides "can pick a save folder" is the **runtime API capability**
// (whether `showDirectoryPicker` exists), not the UA — the server can't infer it from UA alone
// (the same WebView version has different capabilities across platforms). So all of this is a synchronous, zero-cost local check.
//
// Pure functions (UA / touch points injected as params) + a cached wrapper that reads runtime state, for easy unit testing.

export type InAppKind =
  | "wechat"
  | "qq"
  | "weibo"
  | "alipay"
  | "dingtalk"
  | "lark"
  | "bytedance"
  | "baidu"
  | null;

// Keyword table. These app markers are the **inherent behavior** of each vendor's embedded WebView (changing UA would break their own page compatibility),
// and are more reliable than injected objects like WeixinJSBridge / window.mqq — the latter are injected lazily and many pages never inject them.
const IN_APP: { kind: Exclude<InAppKind, null>; label: string; re: RegExp }[] = [
  { kind: "wechat", label: "微信", re: /MicroMessenger/i },
  // ⚠️ Must match "QQ/version" together: the QQ browser (a standalone app that downloads normally) also has MQQBrowser in its UA,
  //    only the in-app QQ browser adds a `QQ/8.x.x` segment. Matching MQQBrowser alone would wrongly flag QQ browser users.
  { kind: "qq", label: "QQ", re: /(?:^|[\s(])QQ\/[\d.]+/ },
  { kind: "weibo", label: "微博", re: /Weibo\//i },
  { kind: "alipay", label: "支付宝", re: /AlipayClient/i },
  { kind: "dingtalk", label: "钉钉", re: /DingTalk/i },
  { kind: "lark", label: "飞书", re: /(?:Lark|Feishu)\//i },
  { kind: "bytedance", label: "抖音/头条", re: /BytedanceMicroApp|aweme/i },
  { kind: "baidu", label: "百度", re: /baiduboxapp/i },
];

export function detectInApp(ua: string): { kind: InAppKind; label: string } {
  for (const p of IN_APP) if (p.re.test(ua)) return { kind: p.kind, label: p.label };
  return { kind: null, label: "" };
}

export function isMobileUa(ua: string, maxTouchPoints = 0): boolean {
  if (/Android|iPhone|iPod|iPad|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua)) return true;
  // iPadOS 13+ desktop mode: the UA masquerades as Macintosh, distinguishable only by touch points (Mac desktop always has 0).
  return /Macintosh/i.test(ua) && maxTouchPoints > 1;
}

// When going with "auto-download after completion", where the file actually lands — platforms differ, and getting it wrong is a false promise.
export function downloadLocationHint(ua: string, maxTouchPoints = 0): string {
  if (/iPhone|iPod|iPad/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1))
    return "「文件」App →「浏览」→「下载项」";
  if (/Android/i.test(ua)) return "「文件管理」App 的「下载」目录";
  return "浏览器的默认下载目录";
}

export interface EnvReport {
  mobile: boolean;
  inApp: InAppKind;
  inAppLabel: string;
  /** Whether a save folder can actually be chosen: the Tauri native dialog, or the PC Chromium File System Access API */
  canSaveToFolder: boolean;
  /** In-app browser: received files likely can't be saved (WeChat/QQ block web downloads); ask the user to switch to the system browser */
  blockedReceive: boolean;
  /** Banner title / body (empty string when canSaveToFolder, in which case no prompt is needed) */
  bannerTitle: string;
  bannerText: string;
  /** One-line hint in the invite card / task card (single source of truth, to avoid drift across places) */
  hint: string;
  showBanner: boolean;
}

export function describeEnv(
  ua: string,
  opts: { maxTouchPoints?: number; canSaveToFolder: boolean },
): EnvReport {
  const touch = opts.maxTouchPoints ?? 0;
  const mobile = isMobileUa(ua, touch);
  const { kind, label } = detectInApp(ua);
  const base = {
    mobile,
    inApp: kind,
    inAppLabel: label,
    canSaveToFolder: opts.canSaveToFolder,
  };
  // PC Chromium / Tauri: use the original "pick folder + stream-to-disk"; no prompt needed at all.
  if (opts.canSaveToFolder) {
    return { ...base, blockedReceive: false, bannerTitle: "", bannerText: "", hint: "", showBanner: false };
  }
  if (kind) {
    return {
      ...base,
      blockedReceive: true,
      bannerTitle: `${label}内置浏览器无法保存网页下载的文件`,
      bannerText: "发送不受影响；接收请点右上角「⋯」→「在浏览器打开」后重新连接。",
      hint: `当前是${label}内置浏览器，无法保存接收到的文件（发送不受影响）· 请点右上角「⋯」→「在浏览器打开」后再接收`,
      showBanner: true,
    };
  }
  const where = downloadLocationHint(ua, touch);
  return {
    ...base,
    blockedReceive: false,
    bannerTitle: "接收的文件会自动下载",
    bannerText: `本机浏览器不能选择保存文件夹，接收的文件会保存到${where}。`,
    hint: `本机浏览器不能选择保存文件夹：文件收齐后会自动下载到${where}`,
    showBanner: true,
  };
}

/** Whether the current environment can "pick a save folder". Tauri uses the native dialog; browsers use the File System Access API. */
export function canSaveToFolder(): boolean {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  return "showDirectoryPicker" in window;
}

let cached: EnvReport | null = null;

/** Read the runtime environment once (result cached; detection is synchronous and zero-cost). */
export function env(): EnvReport {
  if (!cached) {
    cached = describeEnv(navigator.userAgent, {
      maxTouchPoints: navigator.maxTouchPoints,
      canSaveToFolder: canSaveToFolder(),
    });
  }
  return cached;
}

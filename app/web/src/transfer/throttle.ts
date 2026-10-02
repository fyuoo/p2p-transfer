// 后台不节流的事件循环调度工具。
//
// 浏览器后台时 setTimeout/setInterval 会被节流到 ≥1s（intensive timer throttling，
// WebRTC 豁免分钟档后最坏 1s/次）。本项目的发送泵与授信回程都靠"尽快调度"驱动，
// 一旦被限，传输就暂停 / 骤降（接收标签页切后台时尤为明显）。
//
// MessageChannel 的 port 消息任务走渲染进程任务队列，不受 timer throttling 限制
// （与 React scheduler 同源思路），故用于替代 setTimeout(0) 类的"尽快"调度，
// 让后台传输也能持续推进。
//
// 仅浏览器环境启用 MessageChannel；Node（测试 / 服务端）回退 setTimeout(0)，
// 既规避浏览器后台节流，又保证测试环境行为与原先完全一致、零回归。

const MC: typeof MessageChannel | null =
  (typeof MessageChannel !== 'undefined' && typeof window !== 'undefined') ? MessageChannel : null;

let _port: MessagePort | undefined;
let _pending: Array<() => void> = [];

function channel(): MessagePort {
  if (!_port && MC) {
    const ch = new MC();
    ch.port1.onmessage = () => {
      const q = _pending; _pending = [];
      for (const fn of q) fn();
    };
    ch.port2.start();
    _port = ch.port2;
  }
  return _port!;
}

/** 尽快调度一次回调，后台不被 timer 节流。浏览器走 MessageChannel，非浏览器回退 setTimeout(0)。 */
export function unthrottledTick(cb: () => void): void {
  if (MC) { _pending.push(cb); channel().postMessage(0); }
  else setTimeout(cb, 0);
}

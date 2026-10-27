/**
 * 进程级兜底：未处理的 Promise 拒绝 / 未捕获异常只记日志、不让进程静默退出；
 * 退出信号统一转给 onSignal（由 main 装配「停服 → 关 DB → 限时 exit」）。
 *
 * 为什么需要：全仓大量 fire-and-forget 异步（发送回执、记忆提取、插件定时器），Node 24 对
 * 未处理拒绝默认直接退出——任一漏 catch 的 Promise 都会让 bot 悄悄死掉（2026-10）。
 * 只记录不退出：单次回调失败不该拖垮整个服务；真正的启动失败仍走 main 的显式 exit(1)。
 *
 * 导出：installProcessGuards（幂等，进程内只装一次）。
 * 依赖：无（logger 由调用方以 logError 注入，便于测试）。
 */
let installed = false;

/**
 * 安装进程级兜底（幂等）。
 * @param {Object} [opts={}]
 * @param {(msg: string, detail?: any) => void} [opts.logError] - 错误记录函数（默认 console.error）
 * @param {(sig: string) => void} [opts.onSignal] - SIGINT/SIGTERM 处理（不传则忽略信号）
 * @param {NodeJS.EventEmitter} [opts.target=process] - 事件源（测试可注入假 emitter）
 * @returns {boolean} 本次是否真的安装（已装过返回 false）
 */
export function installProcessGuards({
  logError = (msg, detail) => console.error(msg, detail),
  onSignal,
  target = process,
} = {}) {
  if (installed) return false;
  installed = true;
  target.on('unhandledRejection', (reason) => {
    logError('[process] 未处理的 Promise 拒绝（已记录，进程继续）:', reason?.stack || reason);
  });
  target.on('uncaughtException', (error) => {
    logError('[process] 未捕获异常（已记录，进程继续）:', error?.stack || error);
  });
  if (typeof onSignal === 'function') {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      target.on(sig, () => onSignal(sig));
    }
  }
  return true;
}

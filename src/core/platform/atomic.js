/*
 * 原子写盘与损坏文件隔离（2026-10）。
 *
 * 背景：状态类 JSON（词典/缓存/用户记忆/消息水位/会话历史/情节记忆）原为
 * writeFileSync 直接覆盖——进程崩在写中途会留下截断文件；加载失败后各处只记日志
 * 并降级为空表，下一次写入就把旧数据彻底覆盖，等于一次崩溃丢掉整份数据。
 * 本模块提供两件事：
 *   ① writeFileAtomic(file, data)  临时文件 + rename 原子替换（Windows 上 rename 覆盖已存在文件）；
 *   ② quarantineCorrupt(file)     把损坏文件改名为 <file>.corrupt-<时间戳> 保留物证，不静默删除。
 *
 * 对外导出：writeFileAtomic / quarantineCorrupt。纯函数，无实例。
 * 依赖：node:fs；调用点：core/knowledge/lingo.js、cache.js、core/platform/usermem.js、
 * store.js（lastSeen/runtime/群状态/去重重写）、episodic.js、plugins/chat.js（会话历史）。
 * 读写数据：写调用方指定的文件；损坏隔离会重命名原文件。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子写文件：同目录临时文件写完后 rename 覆盖目标（跨 Windows/POSIX 通用）。
 * 失败时清理临时文件并把错误抛给调用方（各调用点沿用既有的「记日志继续」容错）。
 * @param {string} file - 目标文件绝对路径（父目录会自动创建）
 * @param {string|Buffer} data - 文件内容
 * @returns {void}
 * 副作用：写临时文件并 rename；失败时尽力删除临时文件
 */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略清理失败 */ }
    throw e;
  }
}

/**
 * 损坏文件隔离：把解析失败的文件改名保留（`<file>.corrupt-<时间戳>`），
 * 避免「加载失败降级为空表 → 下一次写入覆盖 → 旧数据永久丢失」。
 * @param {string} file - 解析失败的文件路径
 * @returns {string} 隔离后的新路径；文件不存在或改名失败返回 ''（调用方只记日志）
 * 副作用：重命名原文件
 */
export function quarantineCorrupt(file) {
  try {
    if (!fs.existsSync(file)) return '';
    const dst = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, dst);
    return dst;
  } catch {
    return '';
  }
}

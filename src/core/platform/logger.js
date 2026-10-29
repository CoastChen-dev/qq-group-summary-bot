/*
 * 日志模块：把带时间戳的日志行同时输出到控制台与按天轮转的日志文件
 * （默认 <项目根>/logs/YYYY-MM-DD.log；环境变量 LOG_DIR 可覆盖——测试用临时目录隔离，
 * 见 test/log-isolation.mjs），跨天自动轮转并清理 14 天前的旧文件。
 *
 * 导出：log / err。
 * 依赖：Node 内置 fs/path/url；无类导出，被 core 全部服务与全部插件 import 使用
 * （platform/ 内同级引用、knowledge/ 经 ../platform/logger.js、plugins 经 ../core/platform/logger.js）。
 * 数据：**首次写日志时才创建目录**（2026-10：原实现 import 即建 logs/，测试 import 任何模块
 * 都会在生产日志目录留下痕迹）；LOG_DIR 在每次切换日期/目录时重新解析，进程内改也生效。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// platform/（P5a 归类）比原 src/ 深两层：项目根 = __dirname/../../..
const root = path.resolve(__dirname, '..', '..', '..');
const defaultLogsDir = path.join(root, 'logs');

let currentDay = '';
let currentDir = '';
let currentFile = '';

// 当前日志目录：LOG_DIR 优先（测试隔离用），缺省项目根 logs/
function logsDir() {
  const custom = process.env.LOG_DIR;
  return custom ? path.resolve(custom) : defaultLogsDir;
}

function dayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 清理 dir 下超过 14 天的旧日志（删除失败忽略）
function cleanupOld(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    for (const f of files) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        try { fs.unlinkSync(full); } catch { /* 忽略 */ }
      }
    }
  } catch { /* 忽略 */ }
}

// 取当日日志文件：每次写入时检查日期与目录，跨天/换 LOG_DIR 自动轮转；目录懒创建
function getLogFile() {
  const today = dayStr();
  const dir = logsDir();
  if (today !== currentDay || dir !== currentDir) {
    currentDay = today;
    currentDir = dir;
    fs.mkdirSync(dir, { recursive: true });
    currentFile = path.join(dir, `${today}.log`);
    cleanupOld(dir);
  }
  return currentFile;
}

// 本地时间戳（zh-CN、24 小时制），作为日志行前缀
function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function writeLine(line) {
  try {
    fs.appendFileSync(getLogFile(), line + '\n');
  } catch {
    /* 忽略日志文件写入错误 */
  }
}

/**
 * 输出普通信息日志：控制台 stdout 与当日日志文件各一行。
 * @param {...*} args - 待输出的参数（按 String 转换后以空格连接）
 * @returns {void} 副作用：向 <LOG_DIR|logs>/YYYY-MM-DD.log 追加一行（写盘失败静默忽略，不影响主流程）
 */
export function log(...args) {
  const line = `[${ts()}] ${args.map(String).join(' ')}`;
  console.log(line);
  writeLine(line);
}

/**
 * 输出错误日志：带 [ERROR] 前缀，控制台 stderr 与当日日志文件各一行。
 * @param {...*} args - 待输出的参数（按 String 转换后以空格连接）
 * @returns {void} 副作用：向 <LOG_DIR|logs>/YYYY-MM-DD.log 追加一行（写盘失败静默忽略，不影响主流程）
 */
export function err(...args) {
  const line = `[${ts()}][ERROR] ${args.map(String).join(' ')}`;
  console.error(line);
  writeLine(line);
}

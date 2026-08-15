import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const logsDir = path.join(root, 'logs');

fs.mkdirSync(logsDir, { recursive: true });

let currentDay = '';
let currentFile = '';

function dayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 每次写入时检查日期，跨天自动轮转到新文件
function getLogFile() {
  const today = dayStr();
  if (today !== currentDay) {
    currentDay = today;
    currentFile = path.join(logsDir, `${today}.log`);
    // 清理超过 14 天的旧日志
    try {
      const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
      const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
      for (const f of files) {
        const full = path.join(logsDir, f);
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          try { fs.unlinkSync(full); } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
  }
  return currentFile;
}

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

export function log(...args) {
  const line = `[${ts()}] ${args.map(String).join(' ')}`;
  console.log(line);
  writeLine(line);
}

export function err(...args) {
  const line = `[${ts()}][ERROR] ${args.map(String).join(' ')}`;
  console.error(line);
  writeLine(line);
}

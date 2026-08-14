import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.resolve(__dirname, '..', 'bot.log');

function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function writeLine(line) {
  try {
    fs.appendFileSync(logFile, line + '\n');
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

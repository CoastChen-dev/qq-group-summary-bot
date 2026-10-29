/**
 * 基线：日志目录隔离（2026-10）。
 *
 * 背景：logger 默认写项目根 logs/，测试曾把单日生产日志写成 1.7 万行噪声
 * （其中还有 mock.timers 拨到未来日期产生的假日志文件）。锁定：LOG_DIR 优先、
 * 切换目录后写新目录、日志文件按本地日期命名。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from '../../src/core/platform/logger.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

// 与 logger 内部一致的本地日期串
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('logger LOG_DIR 隔离（2026-10）', () => {
  it('LOG_DIR 指向临时目录时写入该目录；切换目录后写新目录', () => {
    const old = process.env.LOG_DIR;
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-log-a-'));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-log-b-'));
    try {
      process.env.LOG_DIR = d1;
      log('隔离测试行 A');
      assert.ok(fs.readFileSync(path.join(d1, `${today()}.log`), 'utf8').includes('隔离测试行 A'));

      process.env.LOG_DIR = d2;
      log('隔离测试行 B');
      const b = fs.readFileSync(path.join(d2, `${today()}.log`), 'utf8');
      assert.ok(b.includes('隔离测试行 B'));
      assert.ok(!b.includes('隔离测试行 A'));
    } finally {
      if (old === undefined) delete process.env.LOG_DIR;
      else process.env.LOG_DIR = old;
      try { fs.rmSync(d1, { recursive: true, force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(d2, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  });
});

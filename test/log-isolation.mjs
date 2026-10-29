/*
 * 测试日志隔离钩子（npm test 经 `node --import ./test/log-isolation.mjs` 预加载）。
 *
 * 背景：logger 默认写项目根 logs/，而测试会大量打日志——2026-10 曾把单日生产日志
 * 写成 1.7 万行测试噪声（其中还有 mock.timers 拨到未来日期产生的假日志文件）。
 * 本模块在测试进程启动前把 LOG_DIR 指到系统临时目录，生产 logs/ 零写入。
 *
 * 说明：node:test 的每个测试子进程继承环境变量，故此钩子只需在父进程执行一次；
 * 直接 `node --test <file>`（未经本钩子）时，test/helpers.js 里还有一层兜底。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.LOG_DIR) {
  process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-test-logs-'));
}

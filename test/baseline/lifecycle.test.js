/**
 * 基线：进程级兜底 installProcessGuards。
 *
 * 锁定目标：未处理拒绝/未捕获异常只记日志、不抛出；信号转给 onSignal；重复安装幂等。
 * 用假 EventEmitter 当 target（不碰真实 process，避免 node:test 把手工 emit 的
 * unhandledRejection 当成测试失败）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { installProcessGuards } from '../../src/core/platform/lifecycle.js';

const seen = { logs: [], signals: [] };
const target = new EventEmitter();
// 首次安装即定型：后面的重复调用必须原样返回 false，不得替换这些回调
const firstInstalled = installProcessGuards({
  logError: (msg, detail) => seen.logs.push([msg, detail]),
  onSignal: (sig) => seen.signals.push(sig),
  target,
});

describe('installProcessGuards 进程级兜底', () => {
  it('首次安装返回 true', () => {
    assert.equal(firstInstalled, true);
  });

  it('未处理拒绝/未捕获异常只记日志，不抛不退出', () => {
    target.emit('unhandledRejection', new Error('boom'));
    target.emit('uncaughtException', new Error('kaboom'));
    assert.equal(seen.logs.length, 2);
    assert.match(String(seen.logs[0][0]), /未处理的 Promise 拒绝/);
    assert.match(String(seen.logs[0][1]), /boom/);
    assert.match(String(seen.logs[1][0]), /未捕获异常/);
    assert.match(String(seen.logs[1][1]), /kaboom/);
  });

  it('幂等：重复安装返回 false，不新增监听、不替换回调', () => {
    const count = target.listenerCount('unhandledRejection');
    const second = installProcessGuards({ logError: () => { throw new Error('不应被调用'); }, target });
    assert.equal(second, false);
    assert.equal(target.listenerCount('unhandledRejection'), count);
    target.emit('unhandledRejection', new Error('again')); // 仍走首次安装的 logger
    assert.equal(seen.logs.length, 3);
  });

  it('SIGINT/SIGTERM 转给 onSignal', () => {
    target.emit('SIGINT');
    target.emit('SIGTERM');
    assert.deepEqual(seen.signals, ['SIGINT', 'SIGTERM']);
  });
});

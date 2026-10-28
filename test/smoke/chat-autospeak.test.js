/**
 * 冒烟：chat 插件的免 @ 自动接话（2026-10，试点群）。
 *
 * 锁定：接话门（群白名单 / 冷却 / 概率 / 每小时上限）、不 @ 人、
 * brain 收到 autoSpeak + 最近群聊语境、普通 @ 路径不受影响。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createChatPlugin } from '../../src/plugins/chat.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function mkBrain(reply = '那就吃面吧') {
  const calls = [];
  return {
    calls,
    async chat(groupId, userName, text, userId, opts) {
      calls.push({ groupId, userName, text, userId, opts });
      return reply;
    },
  };
}

function mkClient() {
  const sent = [];
  return {
    sent,
    sendGroupMsg: async (gid, msg) => { sent.push({ gid, msg }); },
    sendGroupMsgAt: async (gid, uid, msg) => { sent.push({ gid, uid, msg, at: true }); },
  };
}

const ctxOf = (text, extra = {}) => ({
  groupId: 1031477964, userId: 2, userName: '甲', messageId: 1, text, autoSpeak: true, ...extra,
});

const mkPlugin = (autoSpeak = {}) => {
  const brain = mkBrain();
  const client = mkClient();
  const plugin = createChatPlugin({
    brain,
    client,
    autoSpeak: { groups: ['1031477964'], cooldownSeconds: 0, probability: 1, maxPerHour: 10, ...autoSpeak },
    getRecent: () => ['甲：在吗', '乙：饿了'],
  });
  return { plugin, brain, client };
};

describe('chat 免 @ 自动接话', () => {
  it('白名单群 + 信号命中：接话、不 @、带 autoSpeak 与最近语境', async () => {
    const { plugin, brain, client } = mkPlugin();
    assert.equal(plugin.handleMessage(ctxOf('今天晚上吃什么')), true);
    await tick(10);
    assert.equal(brain.calls.length, 1);
    assert.equal(brain.calls[0].opts.autoSpeak, true);
    assert.deepEqual(brain.calls[0].opts.recent, ['甲：在吗', '乙：饿了']);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].msg, '那就吃面吧');
    assert.equal(client.sent[0].at, undefined); // 不 @ 人
  });

  it('冷却内不再接话；非白名单群直接让位', async () => {
    const slow = mkPlugin({ cooldownSeconds: 60 });
    assert.equal(slow.plugin.handleMessage(ctxOf('今天吃什么')), true);
    assert.equal(slow.plugin.handleMessage(ctxOf('那明天吃什么')), null);

    const other = mkPlugin();
    assert.equal(other.plugin.handleMessage(ctxOf('今天吃什么', { groupId: 999 })), null);
    assert.equal(other.brain.calls.length, 0);
  });

  it('普通 @ 路径不变：仍然真 @ 提问者', async () => {
    const { plugin, client } = mkPlugin();
    const ctx = { groupId: 123, userId: 9, userName: '乙', messageId: 2, text: '在吗' };
    assert.equal(plugin.handleMessage(ctx), true);
    await tick(10);
    assert.equal(client.sent[0].at, true);
    assert.equal(client.sent[0].uid, 9);
  });

  it('试点群被 @ 时（noAt）：仍回纯文本，不 @ 人', async () => {
    const { plugin, client } = mkPlugin();
    const ctx = { groupId: 1031477964, userId: 9, userName: '乙', messageId: 3, text: '@机器人 在吗', noAt: true };
    assert.equal(plugin.handleMessage(ctx), true);
    await tick(10);
    assert.equal(client.sent[0].msg, '那就吃面吧');
    assert.equal(client.sent[0].at, undefined);
  });
});

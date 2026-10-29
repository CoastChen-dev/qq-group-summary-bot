/**
 * 冒烟：chat 插件的免 @ 自动接话（2026-10，试点群）。
 *
 * 锁定：确定性过滤（白名单 / @ 了别人 / 节流 / 冷却 / 防叠话）+ **模型自己决定接不接**
 * （回复 <NO_REPLY> = 不接，不再掷概率）、回复不 @ 人、brain 收到 autoSpeak + 最近语境、
 * 普通 @ 路径不受影响。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createChatPlugin } from '../../src/plugins/chat.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** 假 brain：按顺序返回 replies（最后一个循环），记录每次调用的 opts */
function mkBrain(replies = ['那就吃面吧']) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async chat(groupId, userName, text, userId, opts) {
      calls.push({ groupId, userName, text, userId, opts });
      const r = replies[Math.min(i, replies.length - 1)];
      i++;
      return typeof r === 'function' ? r() : r;
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
  groupId: 1031477964, userId: 2, userName: '甲', messageId: 1,
  text, autoSpeak: true, selfId: 10001, atTargets: [], ...extra,
});

const mkPlugin = (autoSpeak = {}, brainReplies = ['那就吃面吧']) => {
  const brain = mkBrain(brainReplies);
  const client = mkClient();
  const plugin = createChatPlugin({
    brain,
    client,
    autoSpeak: {
      groups: ['1031477964'], cooldownSeconds: 0, evalCooldownSeconds: 0, maxPerHour: 10, ...autoSpeak,
    },
    getRecent: () => ['甲：在吗', '乙：饿了'],
  });
  return { plugin, brain, client };
};

describe('chat 免 @ 自动接话', () => {
  it('模型决定接话：发纯文本、不 @ 人，带 autoSpeak 与最近语境', async () => {
    const { plugin, brain, client } = mkPlugin();
    assert.equal(plugin.handleMessage(ctxOf('今天晚上吃什么')), true);
    await tick();
    assert.equal(brain.calls.length, 1);
    assert.equal(brain.calls[0].opts.autoSpeak, true);
    assert.deepEqual(brain.calls[0].opts.recent, ['甲：在吗', '乙：饿了']);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].msg, '那就吃面吧');
    assert.equal(client.sent[0].at, undefined);
  });

  it('模型回 <NO_REPLY>：不发言，也不占用冷却', async () => {
    const { plugin, brain, client } = mkPlugin({}, ['<NO_REPLY>', '这次接一句']);
    plugin.handleMessage(ctxOf('随便聊聊'));
    await tick();
    assert.equal(client.sent.length, 0);

    plugin.handleMessage(ctxOf('那聊点别的'));
    await tick();
    assert.equal(brain.calls.length, 2);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].msg, '这次接一句');
  });

  it('模型回 <NO_REPLY> 带尾随标点：同样不发言（2026-10 容错）', async () => {
    const { plugin, client } = mkPlugin({}, ['<NO_REPLY>。']);
    plugin.handleMessage(ctxOf('随便聊聊'));
    await tick();
    assert.equal(client.sent.length, 0);
  });

  it('消息 @ 了别人：不接，甚至不调用模型', () => {
    const { plugin, brain } = mkPlugin();
    const r = plugin.handleMessage(ctxOf('@m.yun 今晚玩吗', { atTargets: ['999'] }));
    assert.equal(r, null);
    assert.equal(brain.calls.length, 0);
  });

  it('冷却内不再接话；非白名单群直接让位', async () => {
    const slow = mkPlugin({ cooldownSeconds: 60 });
    assert.equal(slow.plugin.handleMessage(ctxOf('今天吃什么')), true);
    await tick();
    assert.equal(slow.plugin.handleMessage(ctxOf('那明天吃什么')), null);

    const other = mkPlugin();
    assert.equal(other.plugin.handleMessage(ctxOf('今天吃什么', { groupId: 999 })), null);
    assert.equal(other.brain.calls.length, 0);
  });

  it('防叠话：上一句还在生成时，新消息不让模型再判', async () => {
    let release;
    const brain = { calls: [], chat() { this.calls.push(1); return new Promise((r) => { release = r; }); } };
    const client = mkClient();
    const plugin = createChatPlugin({
      brain, client,
      autoSpeak: { groups: ['1031477964'], cooldownSeconds: 0, evalCooldownSeconds: 0, maxPerHour: 10 },
      getRecent: () => [],
    });
    assert.equal(plugin.handleMessage(ctxOf('第一句')), true);
    assert.equal(plugin.handleMessage(ctxOf('第二句')), null); // 还在生成 → 不叠
    release('好');
    await tick();
    assert.equal(brain.calls.length, 1);
    assert.equal(client.sent.length, 1);
  });

  it('普通 @ 路径不变：仍然真 @ 提问者', async () => {
    const { plugin, client } = mkPlugin();
    const ctx = { groupId: 123, userId: 9, userName: '乙', messageId: 2, text: '在吗' };
    assert.equal(plugin.handleMessage(ctx), true);
    await tick();
    assert.equal(client.sent[0].at, true);
    assert.equal(client.sent[0].uid, 9);
  });

  it('试点群被 @ 时（noAt）：仍回纯文本，不 @ 人', async () => {
    const { plugin, client } = mkPlugin();
    const ctx = { groupId: 1031477964, userId: 9, userName: '乙', messageId: 3, text: '@机器人 在吗', noAt: true };
    assert.equal(plugin.handleMessage(ctx), true);
    await tick();
    assert.equal(client.sent[0].msg, '那就吃面吧');
    assert.equal(client.sent[0].at, undefined);
  });
});

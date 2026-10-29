/**
 * 冒烟：像真人打字的分条与停顿（humanize）。
 *
 * 锁定：长回复拆成 1–3 条短消息、拼回与原文一致、第一条仍按规则 @；
 * humanize 关闭时退回单条（除非超过 QQ 单条上限）。延迟在测试里设为 0。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createChatPlugin } from '../../src/plugins/chat.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function mkPlugin(humanize = {}, replyOverride = '') {
  const sent = [];
  const client = {
    sendGroupMsg: async (gid, msg) => { sent.push({ gid, msg }); },
    sendGroupMsgAt: async (gid, uid, msg) => { sent.push({ gid, uid, msg, at: true }); },
  };
  const reply = replyOverride || '第一句要写得足够长一些才能触发分条效果。第二句同样要长一点，不然会被合并。第三句继续凑字数，让整体超过六十个字。第四句收尾。';
  const brain = { chat: async () => reply };
  const plugin = createChatPlugin({
    brain, client,
    humanize: { enabled: true, minDelayMs: 0, maxDelayMs: 0, maxBubbles: 3, ...humanize },
  });
  return { plugin, sent, reply };
}

const ctx = { groupId: 9, userId: 555, userName: '博士', messageId: 1, text: '讲讲' };

describe('像真人打字：分条与停顿', () => {
  it('长回复拆成 2–3 条短消息，拼回与原文一致，第一条仍 @', async () => {
    const { plugin, sent, reply } = mkPlugin();
    plugin.handleMessage(ctx);
    await tick(30);
    assert.ok(sent.length >= 2 && sent.length <= 3, `实际 ${sent.length} 条`);
    assert.equal(sent.map((s) => s.msg).join(''), reply);
    assert.equal(sent[0].at, true);
    assert.ok(sent.slice(1).every((s) => !s.at));
  });

  it('>40 字的两句话也会拆成两条，更像连发而不是一段', async () => {
    const reply = '矩阵的秩就是它线性无关的行（或列）的最大个数啦，也就是行空间或列空间的维数。大概这样~';
    const { plugin, sent } = mkPlugin({}, reply);
    plugin.handleMessage({ ...ctx, text: '秩是什么' });
    await tick(30);
    assert.equal(sent.length, 2);
    assert.equal(sent.map((s) => s.msg).join(''), reply);
  });

  it('humanize 关闭：整段一条发出（未超 QQ 单条上限）', async () => {
    const { plugin, sent, reply } = mkPlugin({ enabled: false });
    plugin.handleMessage(ctx);
    await tick(20);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg, reply);
  });
});

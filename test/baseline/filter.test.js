/**
 * 基线：敏感内容过滤（2026-10 出站判定拆分）。
 *
 * 入站仍用完整词表（isSensitive，送 LLM 前过滤）；出站改用 isSensitiveOutbound
 * （隐私模式 + 硬词表），避免闲聊里讨论「密码 / 验证码 / 诈骗 / 自杀」时整条回复
 * 被替换成「这个话题我不太方便聊」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isSensitive, isSensitiveOutbound } from '../../src/core/platform/filter.js';

describe('isSensitiveOutbound（出站兜底，2026-10）', () => {
  it('正常讨论词不再命中：密码/验证码/诈骗/自杀（入站仍然拦截）', () => {
    for (const t of ['验证码诈骗怎么防', '我的密码忘了怎么办', '自杀预防热线是多少']) {
      assert.equal(isSensitive(t), true);
      assert.equal(isSensitiveOutbound(t), false);
    }
  });

  it('隐私模式仍命中：手机号/邮箱/IP', () => {
    assert.equal(isSensitiveOutbound('我的手机号 13800138000'), true);
    assert.equal(isSensitiveOutbound('邮箱 a@b.com'), true);
    assert.equal(isSensitiveOutbound('地址 10.0.0.1'), true);
  });

  it('硬词仍命中：色情/卖淫/赌博', () => {
    assert.equal(isSensitiveOutbound('色情内容'), true);
    assert.equal(isSensitiveOutbound('卖淫'), true);
    assert.equal(isSensitiveOutbound('赌博'), true);
  });

  it('空文本与正常回复放行', () => {
    assert.equal(isSensitiveOutbound(''), false);
    assert.equal(isSensitiveOutbound('今天天气不错，一起打肉鸽吗'), false);
  });
});

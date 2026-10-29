/**
 * 基线：敏感内容过滤（2026-10 重写三档口径）。
 *
 * ① 硬词整条剔除；② 隐私词只在「自述具体值 / 索取递交」句式下命中；③ 隐私正则。
 * 关键回归：密码学/流密码/防诈骗/自杀预防/JAVA 这类正常讨论不再被误删（此前实测一天误删 55 条）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitive, isSensitiveOutbound, filterMessages } from '../../src/core/platform/filter.js';

describe('isSensitive（入站，三档口径）', () => {
  it('正常讨论不再误伤：密码学/防诈骗/自杀预防/自拍/JAVA', () => {
    for (const t of ['密码学作业好难', '流密码和分组密码', '验证码诈骗怎么防', '自杀预防热线是多少', '或者自拍发我也行', 'JAVA 和 AVX 指令集']) {
      assert.equal(isSensitive(t), false, t);
    }
  });

  it('隐私自述/索取句式命中', () => {
    for (const t of ['我的密码是 abc123', '密码：123456', '把验证码发我', '发一下你的手机号', '我的新密码是abc']) {
      assert.equal(isSensitive(t), true, t);
    }
  });

  it('硬词命中：色情/裸照/赌博/毒品', () => {
    for (const t of ['色情内容', '裸照', '赌博', '毒品交易']) assert.equal(isSensitive(t), true, t);
  });

  it('隐私模式命中：手机号/邮箱/身份证/IP', () => {
    assert.equal(isSensitive('我的手机号 13800138000'), true);
    assert.equal(isSensitive('邮箱 a@b.com'), true);
    assert.equal(isSensitive('我的身份证号是 110101199001011234'), true);
    assert.equal(isSensitive('地址 10.0.0.1'), true);
  });

  it('空文本/普通消息放行', () => {
    assert.equal(isSensitive(''), false);
    assert.equal(isSensitive('今天天气不错，一起打肉鸽吗'), false);
  });
});

describe('isSensitiveOutbound（出站，与入站同口径）', () => {
  it('正常讨论放行、隐私自述/硬词拦截', () => {
    assert.equal(isSensitiveOutbound('验证码诈骗怎么防'), false);
    assert.equal(isSensitiveOutbound('我的密码是 abc123'), true);
    assert.equal(isSensitiveOutbound('卖淫'), true);
  });
});

describe('filterMessages', () => {
  it('密码学消息保留；硬词/隐私值消息剔除', () => {
    const recs = [
      { id: '1', text: '今天学了密码学' },
      { id: '2', text: '色情内容' },
      { id: '3', text: '我的手机号 13800138000' },
    ];
    const { kept, filtered } = filterMessages(recs);
    assert.deepEqual(kept.map((r) => r.id), ['1']);
    assert.deepEqual(filtered.map((r) => r.id), ['2', '3']);
  });
});

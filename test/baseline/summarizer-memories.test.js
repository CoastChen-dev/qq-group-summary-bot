/**
 * 基线：Summarizer.extractMemories（日报后提炼 3-5 条情节记忆）。
 *
 * 锁定：请求形状（temperature 0.3 / JSON 提示）、容忍 markdown 包裹、过滤非字符串与空项、
 * 截到 5 条；空记录不发请求。经 global.fetch 桩，无真实网络。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Summarizer } from '../../src/core/platform/summarizer.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

const withFetch = async (stub, fn) => {
  const orig = global.fetch;
  global.fetch = stub;
  try {
    return await fn();
  } finally {
    global.fetch = orig;
  }
};

const recs = [{ time: 1, name: '甲', text: '今晚打方舟吗' }];

describe('Summarizer.extractMemories', () => {
  it('解析 JSON 数组：容忍 markdown 包裹、过滤非字符串/空项、最多 5 条', async () => {
    let body = null;
    const stub = async (url, opts) => {
      body = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '```json\n["小王在玩方舟","群里约好周六开黑",123,"", "a"]\n```' } }],
      }), { status: 200 });
    };
    const s = new Summarizer({ apiKey: 'k', baseUrl: 'https://stub.local', model: 'm' });
    const items = await withFetch(stub, () => s.extractMemories('g1', recs));
    assert.deepEqual(items, ['小王在玩方舟', '群里约好周六开黑']);
    assert.equal(body.temperature, 0.3);
    assert.match(body.messages[1].content, /聊天记录/);
    assert.match(body.messages[1].content, /甲: 今晚打方舟吗/);
  });

  it('空记录：不发请求，直接返回 []', async () => {
    let called = 0;
    const s = new Summarizer({ apiKey: 'k', baseUrl: 'https://stub.local' });
    const items = await withFetch(async () => { called++; return new Response('{}'); }, () => s.extractMemories('g1', []));
    assert.deepEqual(items, []);
    assert.equal(called, 0);
  });
});

/**
 * 行为基线：联网搜索检索器（src/core/knowledge/websearch.js）。
 *
 * 锁定面：未配置 apiKey 自动禁用（不发请求）；zhipu/bocha 两 provider 的请求形状与响应解析；
 * HTTP 失败/无结果返回空且不抛错。经 global.fetch 桩实现，无真实网络。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WebSearchRetriever } from '../../src/core/knowledge/websearch.js';
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

describe('WebSearchRetriever', () => {
  it('未配置 apiKey：自动禁用、不发请求', async () => {
    let called = 0;
    const r = new WebSearchRetriever({ apiKey: '' });
    const out = await withFetch(async () => { called++; return new Response('{}', { status: 200 }); }, () => r.retrieve('测试'));
    assert.equal(r.enabled, false);
    assert.deepEqual(out, { context: '', sources: [], scoreSize: 0 });
    assert.equal(called, 0);
  });

  it('zhipu：请求形状与 search_result 解析（空白归一、无标题条目过滤）', async () => {
    let seen = null;
    const stub = async (url, opts) => {
      seen = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
      return new Response(JSON.stringify({ search_result: [
        { title: '标题A', link: 'https://a.example', content: '摘要 A  内容' },
        { title: '', link: '', content: '无标题条目' },
      ] }), { status: 200 });
    };
    const r = new WebSearchRetriever({ provider: 'zhipu', apiKey: 'k', count: 5 });
    const out = await withFetch(stub, () => r.retrieve('初音未来是谁'));
    assert.equal(seen.url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
    assert.equal(seen.body.search_engine, 'search_std');
    assert.equal(seen.body.search_query, '初音未来是谁');
    assert.equal(seen.auth, 'Bearer k');
    assert.ok(out.context.startsWith('【联网搜索】'));
    assert.ok(out.context.includes('标题A') && out.context.includes('摘要 A 内容'));
    assert.deepEqual(out.sources, ['标题A']);
  });

  it('bocha：data.webPages.value 解析', async () => {
    let seenUrl = '';
    const stub = async (url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ data: { webPages: { value: [
        { name: '博查标题', url: 'https://b.example', summary: '博查摘要' },
      ] } } }), { status: 200 });
    };
    const r = new WebSearchRetriever({ provider: 'bocha', apiKey: 'k' });
    const out = await withFetch(stub, () => r.retrieve('原神是什么'));
    assert.equal(seenUrl, 'https://api.bochaai.com/v1/web-search');
    assert.ok(out.context.includes('博查标题') && out.context.includes('博查摘要'));
  });

  it('HTTP 失败 / 空结果：返回空且不抛错', async () => {
    const r = new WebSearchRetriever({ apiKey: 'k' });
    const fail = await withFetch(async () => new Response('err', { status: 500 }), () => r.retrieve('x'));
    assert.deepEqual(fail, { context: '', sources: [], scoreSize: 0 });
    const empty = await withFetch(async () => new Response(JSON.stringify({ search_result: [] }), { status: 200 }), () => r.retrieve('x'));
    assert.equal(empty.context, '');
  });
});

/**
 * P3 冒烟：ChatBrain（src/plugins/chat.js，原 chat.js 服务上移改造）。
 *
 * 锁定面：① chatEnabled=false 整链短路（不触任何注入服务/网络）；② 构造注入的
 * lingo/arkdb/cache/usermem 等与装配层是同一对象引用（服务上移语义——指令插件 ctx 与
 * brain 共享单例）；③ buildMessages 的实名上下文与用户记忆注入（昵称进 prompt、QQ 不进）；
 * ④ 记忆提取输出解析（_parseFacts 容错）。
 * 14 步 chat() 联网主流程不做直测（需 LLM key 与网络），行为由逐字迁移 + 构造保真兜底。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { ChatBrain, createChatTools } from '../../src/plugins/chat.js';
import { UserMemory } from '../../src/core/platform/usermem.js';
import { cleanupTmpDirs, makeTmp, silenceLog } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

describe('ChatBrain 构造与开关（P3 服务上移）', () => {
  it('chatEnabled=false：chat() 整链短路返回 null，不触碰注入服务', async () => {
    const brain = new ChatBrain({ cfg: { chatEnabled: false } });
    assert.equal(await brain.chat('g1', '昵称', '随便问点什么'), null);
  });

  it('构造注入：知识服务与装配层共享同一引用（事实共享单例）', () => {
    const deps = {
      cfg: {},
      lingo: { name: 'lingo' },
      arkdb: { name: 'arkdb' },
      cache: { name: 'cache' },
      wiki: { name: 'wiki' },
      moegirl: { name: 'moegirl' },
      wikipedia: { name: 'wikipedia' },
      usermem: { name: 'usermem' },
      memoryCfg: { autoExtract: false },
    };
    const brain = new ChatBrain(deps);
    assert.equal(brain.lingo, deps.lingo);
    assert.equal(brain.arkdb, deps.arkdb);
    assert.equal(brain.cache, deps.cache);
    assert.equal(brain.wiki, deps.wiki);
    assert.equal(brain.moegirl, deps.moegirl);
    assert.equal(brain.wikipedia, deps.wikipedia);
    assert.equal(brain.usermem, deps.usermem);
    assert.equal(brain.memoryAutoExtract, false);
    assert.equal(brain.enabled, true); // cfg 缺省 chatEnabled 视为开（与旧 ChatBot 一致）
    assert.equal(brain.historyLimit, 12);
  });
});

describe('ChatBrain buildMessages 实名上下文与用户记忆', () => {
  it('system 恒在首位；昵称进 messages、QQ 不进；发言前缀 = 昵称', () => {
    const brain = new ChatBrain({ cfg: {} });
    const msgs = brain.buildMessages('g1', '真实昵称XYZ', '波登可是谁', '知识上下文', 'u9');
    assert.equal(msgs[0].role, 'system');
    const user = msgs[msgs.length - 1];
    assert.ok(user.content.startsWith('真实昵称XYZ：波登可是谁'));
    assert.ok(!JSON.stringify(msgs).includes('u9'), 'QQ 不得进 prompt');
    assert.ok(user.content.includes('知识上下文')); // wikiContext 拼在当前问题之后
  });

  it('用户记忆注入：提问者本人的事实进【用户记忆】段', (t) => {
    const dir = makeTmp();
    const mem = new UserMemory(path.join(dir, 'user_memory.json'));
    mem.setFact('g1', 'u9', '张三', '喜欢夜莺');
    const brain = new ChatBrain({ cfg: {}, usermem: mem });
    const user = brain.buildMessages('g1', '张三', '随便聊聊', '', 'u9').pop();
    assert.ok(user.content.includes('【用户记忆】'));
    assert.ok(user.content.includes('喜欢夜莺'));
  });

  it('用户记忆注入：问题里点名的其他成员记忆也进上下文（按群隔离）', (t) => {
    const dir = makeTmp();
    const mem = new UserMemory(path.join(dir, 'user_memory.json'));
    mem.setFact('g1', 'u8', '李四', '在医疗部工作');
    const brain = new ChatBrain({ cfg: {}, usermem: mem });
    brain.buildMessages('g1', '李四', '大家好', '', 'u8'); // 先让 brain 认识李四
    const user = brain.buildMessages('g1', '张三', '李四在哪里工作？', '', 'u9').pop();
    assert.ok(user.content.includes('李四：在医疗部工作'));
  });

  it('未注入 usermem：无【用户记忆】段（功能关闭时零注入）', () => {
    const brain = new ChatBrain({ cfg: {} });
    const user = brain.buildMessages('g1', '张三', '你好', '', 'u9').pop();
    assert.ok(!user.content.includes('【用户记忆】'));
  });

  it('_parseFacts：容忍 markdown 包裹/前后缀；非数组与坏 JSON 返回空', () => {
    const brain = new ChatBrain({ cfg: {} });
    assert.deepEqual(brain._parseFacts('```json\n["喜欢夜莺", "在医疗部工作"]\n```'), ['喜欢夜莺', '在医疗部工作']);
    assert.deepEqual(brain._parseFacts('结果如下：["爱喝咖啡"] 完毕'), ['爱喝咖啡']);
    assert.deepEqual(brain._parseFacts('[]'), []);
    assert.deepEqual(brain._parseFacts('没有可记的'), []);
    assert.deepEqual(brain._parseFacts('["好", 123, "", "  "]'), []); // 过滤 <2 字/非字符串
  });
});

describe('ChatBrain 工具调用（function calling）', () => {
  it('createChatTools：react_emoji 名称解析 → 调 react；未知名称返回提示不抛错', async () => {
    const reacted = [];
    const tools = createChatTools({ react: async (mid, id) => { reacted.push([mid, id]); } });
    const reactTool = tools.find((t) => t.name === 'react_emoji');
    assert.equal(await reactTool.handler({ emoji: '吃瓜' }, { messageId: 'm1' }), '已给当前消息贴上表情：吃瓜');
    assert.deepEqual(reacted, [['m1', '271']]); // 吃瓜 = ID 271（NapCat 官方表）
    const bad = await reactTool.handler({ emoji: '不存在的表情' }, { messageId: 'm1' });
    assert.ok(bad.includes('没有找到表情'));
    assert.equal(reacted.length, 1); // 解析失败不调用 react
  });

  it('createChatTools：同群贴表情冷却（风控降险）', async () => {
    const reacted = [];
    const reactTool = createChatTools({ react: async (mid, id) => { reacted.push(id); }, emojiCooldownMs: 60000 })
      .find((t) => t.name === 'react_emoji');
    assert.equal(await reactTool.handler({ emoji: '赞' }, { messageId: 'm1', groupId: 'g1' }), '已给当前消息贴上表情：赞');
    const second = await reactTool.handler({ emoji: '吃瓜' }, { messageId: 'm2', groupId: 'g1' });
    assert.ok(second.includes('刚贴过表情'), `冷却期应提示: ${second}`);
    assert.equal(reacted.length, 1); // 冷却期内不再调用 react
    assert.equal(await reactTool.handler({ emoji: '吃瓜' }, { messageId: 'm3', groupId: 'g2' }), '已给当前消息贴上表情：吃瓜'); // 他群不受影响
    assert.equal(reacted.length, 2);
  });

  it('createChatTools：react 未启用 / 无 messageId 的守卫', async () => {
    const off = createChatTools({ react: null }).find((t) => t.name === 'react_emoji');
    assert.equal(await off.handler({ emoji: '赞' }, { messageId: 'm1' }), '贴表情功能未启用');
    const noMid = createChatTools({ react: async () => {} }).find((t) => t.name === 'react_emoji');
    assert.equal(await noMid.handler({ emoji: '赞' }, {}), '当前消息无法定位，贴表情失败');
  });

  it('createChatTools：查询与记忆工具（干员查询、记忆读写）', async () => {
    const dir = makeTmp();
    const mem = new UserMemory(path.join(dir, 'user_memory.json'));
    mem.setFact('g1', 'u1', '张三', '喜欢夜莺');
    const arkdb = {
      findByName: () => ({ name: '能天使', rarity: 'TIER_6', profession: 'SNIPER', birthday: '5月25日', race: '鲁珀', height: '160cm', desc: '企鹅物流' }),
      findOperatorFuzzy: () => null,
    };
    const tools = createChatTools({ arkdb, usermem: mem });
    const names = tools.map((x) => x.name);
    assert.ok(names.includes('query_operator') && names.includes('query_user_memory') && names.includes('remember'));

    const op = await tools.find((x) => x.name === 'query_operator').handler({ name: '能天使' }, {});
    assert.ok(op.includes('能天使') && op.includes('5月25日'));

    const ctx = { groupId: 'g1', userId: 'u2', userName: '李四' };
    const remember = tools.find((x) => x.name === 'remember');
    assert.equal(await remember.handler({ content: '在医疗部工作' }, ctx), '已记住：在医疗部工作');
    assert.deepEqual(mem.listFacts('g1', 'u2').map((f) => f.text), ['在医疗部工作']);
    const q = await tools.find((x) => x.name === 'query_user_memory').handler({}, ctx);
    assert.ok(q.includes('在医疗部工作'));
    const q2 = await tools.find((x) => x.name === 'query_user_memory').handler({ name: '张三' }, ctx);
    assert.ok(q2.includes('喜欢夜莺'));
  });

  it('_llmChat：工具调用 → 执行 → 回填 → 再生成；未知工具/坏参数以文本回填不执行', async () => {
    const seen = [];
    const brain = new ChatBrain({
      cfg: { apiKey: 'k' },
      tools: [{ name: 'echo', description: 'x', parameters: { type: 'object' }, handler: async (args, ctx) => { seen.push([args, ctx.messageId]); return '工具结果'; } }],
    });
    const origFetch = global.fetch;
    let round = 0;
    global.fetch = async () => {
      round++;
      if (round === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"a":1}' } },
          { id: 'c2', type: 'function', function: { name: 'nope', arguments: '{}' } },
          { id: 'c3', type: 'function', function: { name: 'echo', arguments: '{bad' } },
        ] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '最终回复' } }] }), { status: 200 });
    };
    try {
      const reply = await brain._llmChat([{ role: 'user', content: 'hi' }], { groupId: 'g1', messageId: 'm1' });
      assert.equal(reply, '最终回复');
      assert.equal(round, 2);
      assert.deepEqual(seen, [[{ a: 1 }, 'm1']]); // 仅合法调用执行
    } finally {
      global.fetch = origFetch;
    }
  });

  it('检索门提速：闲聊跳过通用检索，提问才触发萌娘/维基', async () => {
    const calls = { moegirl: 0 };
    const mk = () => new ChatBrain({
      cfg: { apiKey: 'k' },
      lingo: { lookup: () => null },
      cache: { get: () => null, set: () => {}, hit: () => {} },
      wiki: { retrieve: async () => ({ context: '', sources: [] }) },
      moegirl: { retrieve: async () => { calls.moegirl++; return { context: '', sources: [] }; } },
      wikipedia: { enabled: false, retrieve: async () => ({ context: '', sources: [] }) },
    });
    const origFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的' } }] }), { status: 200 });
    try {
      await mk().chat('g1', '张三', '哈哈哈哈', 'u1');
      assert.equal(calls.moegirl, 0, '闲聊不应触发通用检索');
      await mk().chat('g1', '张三', '初音未来是谁', 'u1');
      assert.equal(calls.moegirl, 1, '提问应触发通用检索');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('联网搜索启用时取代萌娘/维基（减少百科依赖）', async () => {
    const calls = { moegirl: 0, web: 0 };
    const brain = new ChatBrain({
      cfg: { apiKey: 'k' },
      lingo: { lookup: () => null },
      cache: { get: () => null, set: () => {}, hit: () => {} },
      wiki: { retrieve: async () => ({ context: '', sources: [] }) },
      moegirl: { retrieve: async () => { calls.moegirl++; return { context: '', sources: [] }; } },
      wikipedia: { enabled: true, retrieve: async () => ({ context: '', sources: [] }) },
      webSearch: { enabled: true, timeoutMs: 5000, retrieve: async () => { calls.web++; return { context: '【联网搜索】测试', sources: ['x'], scoreSize: 10 }; } },
    });
    const origFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的' } }] }), { status: 200 });
    try {
      await brain.chat('g1', '张三', '初音未来是谁', 'u1');
      assert.equal(calls.web, 1);
      assert.equal(calls.moegirl, 0); // 联网搜索启用后不再调用萌娘
    } finally {
      global.fetch = origFetch;
    }
  });

  it('chat() 全链回归：messageId 透传到工具（曾因最终 _reply 漏传 opts 导致贴表情无法定位）', async () => {
    const reacted = [];
    const brain = new ChatBrain({
      cfg: { apiKey: 'k' },
      lingo: { lookup: () => null },
      cache: { get: () => null, set: () => {}, hit: () => {} },
      wiki: { retrieve: async () => ({ context: '', sources: [] }) },
      moegirl: { retrieve: async () => ({ context: '', sources: [] }) },
      wikipedia: { enabled: false, retrieve: async () => ({ context: '', sources: [] }) },
      tools: [{
        name: 'react_emoji',
        description: 'x',
        parameters: { type: 'object' },
        handler: async (args, ctx) => { reacted.push(ctx.messageId); return '已贴'; },
      }],
    });
    const origFetch = global.fetch;
    let round = 0;
    global.fetch = async () => {
      round++;
      if (round === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'react_emoji', arguments: '{"emoji":"赞"}' } },
        ] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的' } }] }), { status: 200 });
    };
    try {
      const reply = await brain.chat('g1', '张三', '随便聊聊', 'u1', { messageId: 'm9' });
      assert.equal(reply, '好的');
      assert.deepEqual(reacted, ['m9']); // 工具拿到的 messageId 来自 chat() 的 opts
    } finally {
      global.fetch = origFetch;
    }
  });
});

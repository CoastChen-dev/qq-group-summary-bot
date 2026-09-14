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

import { ChatBrain } from '../../src/plugins/chat.js';
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

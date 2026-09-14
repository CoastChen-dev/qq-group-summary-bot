/**
 * 行为基线：用户记忆库（src/core/platform/usermem.js）。
 *
 * 锁定目标：JSON 整文件读写往返、同文去重、每人/全局容量淘汰（丢最旧）、按群隔离、
 * 按昵称找人、删除单条/整人、损坏文件容错（空表继续）、dump/计数。
 * 全部用 tmp 目录真实落盘，不依赖网络/LLM。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { UserMemory } from '../../src/core/platform/usermem.js';
import { cleanupTmpDirs, makeTmp, silenceLog } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

/** 建一个落盘于独立 tmp 目录的 UserMemory */
function makeMem(opts) {
  const dir = makeTmp();
  return { dir, file: path.join(dir, 'user_memory.json'), mem: new UserMemory(path.join(dir, 'user_memory.json'), opts) };
}

describe('UserMemory 读写', () => {
  it('setFact/listFacts：按群隔离、落盘后新实例可读回', (t) => {
    const { file, mem } = makeMem();
    assert.deepEqual(mem.setFact('g1', 'u1', '张三', '喜欢夜莺'), { ok: true, dup: false });
    assert.deepEqual(mem.setFact('g1', 'u1', '张三', '在医疗部工作'), { ok: true, dup: false });
    mem.setFact('g2', 'u1', '张三', '另一个群的事');

    assert.deepEqual(mem.listFacts('g1', 'u1').map((f) => f.text), ['喜欢夜莺', '在医疗部工作']);
    assert.deepEqual(mem.listFacts('g2', 'u1').map((f) => f.text), ['另一个群的事']);
    assert.deepEqual(mem.listFacts('g1', 'nobody'), []);

    const reloaded = new UserMemory(file); // 整文件覆盖写 → 新实例读回
    assert.deepEqual(reloaded.listFacts('g1', 'u1').map((f) => f.text), ['喜欢夜莺', '在医疗部工作']);
    assert.equal(reloaded.countUsers(), 2);
    assert.equal(reloaded.countFacts(), 3);
  });

  it('同文去重：重复内容只刷新时间并标记 dup；<2 字拒收', (t) => {
    const { mem } = makeMem();
    mem.setFact('g1', 'u1', '张三', '喜欢夜莺');
    assert.deepEqual(mem.setFact('g1', 'u1', '张三', '喜欢夜莺'), { ok: true, dup: true });
    assert.equal(mem.listFacts('g1', 'u1').length, 1);
    assert.deepEqual(mem.setFact('g1', 'u1', '张三', '好'), { ok: false, reason: '内容太短' });
  });

  it('每人容量：超 maxPerUser 丢最旧', (t) => {
    const { mem } = makeMem({ maxPerUser: 3 });
    for (const s of ['一', '二', '三', '四']) mem.setFact('g1', 'u1', '张三', `事实${s}`);
    assert.deepEqual(mem.listFacts('g1', 'u1').map((f) => f.text), ['事实二', '事实三', '事实四']);
  });

  it('全局容量：超 maxGlobal 全局丢最旧（跨群跨人）', (t) => {
    const { mem } = makeMem({ maxGlobal: 3 });
    mem.setFact('g1', 'u1', '张三', '事实A');
    mem.setFact('g1', 'u2', '李四', '事实B');
    mem.setFact('g2', 'u1', '张三', '事实C');
    mem.setFact('g2', 'u2', '李四', '事实D'); // 触发淘汰 事实A
    assert.equal(mem.countFacts(), 3);
    assert.ok(!mem.dump().some((e) => e.facts.some((f) => f.text === '事实A')));
    assert.ok(mem.dump().some((e) => e.facts.some((f) => f.text === '事实D')));
  });
});

describe('UserMemory 查询与管理', () => {
  it('findByMention：按群内昵称精确找人（同名多人全返回）', (t) => {
    const { mem } = makeMem();
    mem.setFact('g1', 'u1', '张三', '喜欢夜莺');
    mem.setFact('g1', 'u2', '张三', '同名的人');
    mem.setFact('g2', 'u3', '张三', '别的群');
    assert.deepEqual(mem.findByMention('g1', '张三').map((x) => x.userId).sort(), ['u1', 'u2']);
    assert.deepEqual(mem.findByMention('g1', '不存在'), []);
  });

  it('forgetUser：清空整人记忆（空容器回收）；removeFact：删指定下标', (t) => {
    const { mem } = makeMem();
    mem.setFact('g1', 'u1', '张三', '事实一');
    mem.setFact('g1', 'u1', '张三', '事实二');
    assert.equal(mem.removeFact('g1', 'u1', 0), true);
    assert.deepEqual(mem.listFacts('g1', 'u1').map((f) => f.text), ['事实二']);
    assert.equal(mem.removeFact('g1', 'u1', 5), false); // 越界
    assert.equal(mem.forgetUser('g1', 'u1'), true);
    assert.equal(mem.forgetUser('g1', 'u1'), false); // 已无
    assert.equal(mem.countUsers(), 0); // 空群容器已回收
  });

  it('文件损坏：构造不抛、空表继续、可重新写入', (t) => {
    const dir = makeTmp();
    const file = path.join(dir, 'user_memory.json');
    fs.writeFileSync(file, '{ 坏 JSON');
    const mem = new UserMemory(file);
    assert.equal(mem.countFacts(), 0);
    mem.setFact('g1', 'u1', '张三', '恢复');
    assert.equal(new UserMemory(file).countFacts(), 1);
  });
});

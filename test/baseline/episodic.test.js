/**
 * 基线：情节记忆 EpisodicMemory（data/memory/<群号>/<日期>.json）。
 *
 * 锁定：按群按天保存、同一天覆盖、最近 N 天按日期升序、format 拼装与截断、
 * 空/损坏数据不影响读取。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EpisodicMemory } from '../../src/core/platform/episodic.js';
import { cleanupTmpDirs, makeTmp, silenceLog } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

const mk = (opts) => new EpisodicMemory(makeTmp(), opts);

describe('EpisodicMemory', () => {
  it('保存 / 覆盖 / 按日期升序读最近 N 天', () => {
    const e = mk({ days: 3 });
    assert.equal(e.save('g1', '2026-10-26', ['小王在玩方舟']), true);
    assert.equal(e.save('g1', '2026-10-27', ['群里约好周六开黑']), true);
    e.save('g1', '2026-10-27', ['覆盖后的内容']);
    const got = e.recent('g1');
    assert.deepEqual(got.map((x) => x.date), ['2026-10-26', '2026-10-27']);
    assert.deepEqual(got[1].items, ['覆盖后的内容']);
    assert.deepEqual(e.recent('g1', 1).map((x) => x.date), ['2026-10-27']);
  });

  it('format：带 MM-DD 与相对时间、超长截断；没有记忆返回空串', () => {
    const e = mk({ days: 3, maxChars: 500 });
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    assert.equal(e.format('g1'), '');
    e.save('g1', day(2), ['小王在玩方舟']);
    e.save('g1', day(1), ['群里约好周六开黑', '阿米娅喜欢甜食']);
    const text = e.format('g1');
    assert.match(text, /（2天前）：小王在玩方舟/);
    assert.match(text, /（昨天）：群里约好周六开黑；阿米娅喜欢甜食/);
    const short = e.format('g1', 3, 12);
    assert.ok(short.length <= 13 && short.endsWith('…'));
  });

  it('保留窗口：超过 retentionDays 的旧文件删除', () => {
    const dir = makeTmp();
    const e = new EpisodicMemory(dir, { retentionDays: 30 });
    const old = '2026-01-01';
    fs.mkdirSync(path.join(dir, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'g1', `${old}.json`), JSON.stringify({ date: old, items: ['旧记忆'] }));
    const today = new Date().toISOString().slice(0, 10);
    e.save('g1', today, ['新记忆']);
    assert.equal(fs.existsSync(path.join(dir, 'g1', `${old}.json`)), false);
    assert.equal(fs.existsSync(path.join(dir, 'g1', `${today}.json`)), true);
  });

  it('脏数据：空条目/超短/损坏文件都不影响其余记忆', () => {
    const dir = makeTmp();
    const e = new EpisodicMemory(dir, { days: 3 });
    e.save('g1', '2026-10-26', ['a', '这是一条正常记忆']);
    fs.writeFileSync(path.join(dir, 'g1', '2026-10-27.json'), '{坏 JSON');
    const got = e.recent('g1');
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].items, ['这是一条正常记忆']);
  });
});

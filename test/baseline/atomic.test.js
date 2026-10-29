/**
 * 基线：原子写盘与损坏文件隔离（2026-10）。
 *
 * 锁定目标：writeFileAtomic 原子替换且不留 .tmp；quarantineCorrupt 改名留证；
 * UserMemory / LingoStore 加载损坏文件时不再「静默空表 + 下一次写入覆盖旧数据」。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic, quarantineCorrupt } from '../../src/core/platform/atomic.js';
import { UserMemory } from '../../src/core/platform/usermem.js';
import { LingoStore } from '../../src/core/knowledge/lingo.js';
import { cleanupTmpDirs, makeTmp, silenceLog } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

describe('writeFileAtomic / quarantineCorrupt', () => {
  it('原子写入：创建父目录、覆盖已有文件、不留下 .tmp', () => {
    const dir = makeTmp();
    const file = path.join(dir, 'sub', 'a.json');
    writeFileAtomic(file, '{"a":1}');
    writeFileAtomic(file, '{"a":2}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), ['a.json']);
  });

  it('quarantineCorrupt：改名为 .corrupt-* 并返回新路径；文件不存在返回空串', () => {
    const dir = makeTmp();
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{坏');
    const moved = quarantineCorrupt(file);
    assert.ok(moved.startsWith(`${file}.corrupt-`));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(moved, 'utf8'), '{坏');
    assert.equal(quarantineCorrupt(file), '');
  });
});

describe('损坏状态文件：隔离而不是静默覆盖（2026-10）', () => {
  it('UserMemory：损坏文件改名留证，空库可继续写入', () => {
    const dir = makeTmp();
    const file = path.join(dir, 'user_memory.json');
    fs.writeFileSync(file, '{坏');
    const mem = new UserMemory(file);
    assert.equal(mem.countFacts(), 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('user_memory.json.corrupt-')));
    mem.setFact('g1', 'u1', '小张', '喜欢明日方舟');
    assert.equal(mem.countFacts(), 1);
  });

  it('LingoStore：损坏文件改名留证，空词典可继续学习', () => {
    const dir = makeTmp();
    const file = path.join(dir, 'lingo.json');
    fs.writeFileSync(file, '{坏');
    const lingo = new LingoStore(file);
    assert.equal(lingo.size(), 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('lingo.json.corrupt-')));
    lingo.learn('轮椅轴', '挂机套路');
    assert.equal(lingo.size(), 1);
  });
});

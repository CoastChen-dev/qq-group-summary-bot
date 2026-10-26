/**
 * 基线：DataRefresher 的「下载 → 结构校验 → 原子替换」与 .bak 清理。
 *
 * 覆盖点（2026-10 起：刷新不再留 .bak 回滚点，成功后顺手清历史 .bak）：
 *   1. 200 + 合法表 → 4 张表全部落地、历史 .bak 被清、无 .tmp 残留、.etags.json 写回；
 *   2. 304 → 视为未变化，不写盘、不动已有表；
 *   3. 校验不过（干员数不足）→ 该表计 failed，已有文件保持原样。
 * 用 stub fetch 走真实 refresh() 分支，不联网。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataRefresher } from '../../src/core/platform/refresher.js';

// 各表的最小合法载荷（刚好过 refresher 的结构校验门槛）
const PAYLOAD = {
  'character_table.json': () => JSON.stringify({
    characters: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`c${i}`, { name: `干员${i}` }])),
  }),
  'handbook_info_table.json': () => JSON.stringify({
    handbookDict: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`h${i}`, { story: 'x' }])),
  }),
  'roguelike_topic_table.json': () => JSON.stringify({
    relics: Array.from({ length: 600 }, (_, i) => ({ type: 'RELIC', name: `藏品${i}` })),
  }),
  'gacha_table.json': () => JSON.stringify({
    gachaPoolClient: Array.from({ length: 20 }, (_, i) => ({
      poolId: `pool_${i}`,
      poolName: `限定寻访·第${i}期`,
      gachaPoolId: `LIMITED_${i}`,
      openTime: 1700000000 + i,
    })),
  }),
};

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ark-refresher-'));
}

// stub fetch：status=304 时模拟未变化；否则按 URL 末段给对应合法表
function stubFetch({ status = 200, badCharacters = false } = {}) {
  return async (url) => {
    if (status === 304) {
      return { status: 304, ok: false, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
    }
    const name = path.basename(new URL(url).pathname);
    let body;
    if (badCharacters && name === 'character_table.json') body = JSON.stringify({ characters: {} });
    else body = PAYLOAD[name]();
    return {
      status: 200,
      ok: true,
      headers: { get: () => `"etag-${name}"` },
      arrayBuffer: async () => Buffer.from(body, 'utf8'),
    };
  };
}

describe('DataRefresher（原子替换 + .bak 清理）', () => {
  test('成功刷新：4 表落地、历史 .bak 被清、无 .tmp 残留、etag 写回', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'character_table.json'), '{"characters":{}}');
    fs.writeFileSync(path.join(dir, 'character_table.json.bak'), '旧版干员表');
    fs.writeFileSync(path.join(dir, 'gacha_table.json.bak'), '旧版卡池表');
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch();
    try {
      const r = await new DataRefresher(dir, { baseUrl: 'http://stub.local' }).refresh();
      assert.deepEqual(r.failed, []);
      assert.equal(r.updated.length, 4);
      assert.equal(fs.existsSync(path.join(dir, 'character_table.json.bak')), false);
      assert.equal(fs.existsSync(path.join(dir, 'gacha_table.json.bak')), false);
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
      const chars = JSON.parse(fs.readFileSync(path.join(dir, 'character_table.json'), 'utf8'));
      assert.ok(Object.keys(chars.characters).length >= 500);
      assert.ok(fs.readFileSync(path.join(dir, '.etags.json'), 'utf8').includes('etag-character_table.json'));
    } finally {
      globalThis.fetch = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('304 未变化：不写盘、已有表原样保留', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'character_table.json'), '{"characters":{"keep":true}}');
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch({ status: 304 });
    try {
      const r = await new DataRefresher(dir, { baseUrl: 'http://stub.local' }).refresh();
      assert.equal(r.updated.length, 0);
      assert.equal(r.unchanged.length, 4);
      assert.equal(fs.readFileSync(path.join(dir, 'character_table.json'), 'utf8'), '{"characters":{"keep":true}}');
    } finally {
      globalThis.fetch = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('结构校验不过：该表 failed，旧文件不被覆盖', async () => {
    const dir = makeDir();
    const old = '{"characters":{"keep":true}}';
    fs.writeFileSync(path.join(dir, 'character_table.json'), old);
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch({ badCharacters: true });
    try {
      const r = await new DataRefresher(dir, { baseUrl: 'http://stub.local' }).refresh();
      assert.equal(r.failed.length, 1);
      assert.ok(r.failed[0].startsWith('干员表'));
      assert.equal(fs.readFileSync(path.join(dir, 'character_table.json'), 'utf8'), old);
      assert.equal(fs.existsSync(path.join(dir, 'character_table.json.tmp')), false);
    } finally {
      globalThis.fetch = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

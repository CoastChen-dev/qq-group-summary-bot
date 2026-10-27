/**
 * 基线：出站文本切分 splitMessage。
 *
 * 锁定目标：每块 UTF-8 字节 ≤ 预算、正文不丢（只裁断点空白）、优先在换行/句末断开、
 * 空文本返回空数组。动机见模块头注释（LLM 长回复超 QQ 单条上限被拒发）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { splitMessage, MAX_MESSAGE_BYTES } from '../../src/core/platform/text.js';

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const squash = (s) => s.replace(/\s+/g, '');

describe('splitMessage 出站文本切分', () => {
  it('短文本原样返回；空文本返回空数组', () => {
    assert.deepEqual(splitMessage('你好'), ['你好']);
    assert.deepEqual(splitMessage(''), []);
    assert.deepEqual(splitMessage(null), []);
  });

  it('长中文按字节预算切块：每块 ≤ 3500B，正文不丢', () => {
    const text = '这是一句用于测试切分的较长中文。'.repeat(300); // ≈6900B
    const chunks = splitMessage(text);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) assert.ok(bytes(c) <= MAX_MESSAGE_BYTES, `超预算: ${bytes(c)}`);
    assert.equal(squash(chunks.join('')), squash(text));
  });

  it('优先在换行处断开，不把一句话劈开', () => {
    const line = '第一段内容'.repeat(40); // 200 字 ≈600B
    const text = Array.from({ length: 8 }, (_, i) => `${line}${i}`).join('\n'); // ≈4800B
    const chunks = splitMessage(text);
    assert.ok(chunks.length >= 2);
    // 除最后一块外，每块都应是完整的行（不以半个字结尾）
    for (const c of chunks.slice(0, -1)) assert.ok(!c.endsWith('第一'), c.slice(-6));
    assert.equal(squash(chunks.join('')), squash(text));
  });

  it('英文长文本：按预算切块并保留全部内容', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(200); // ≈8800B
    const chunks = splitMessage(text);
    for (const c of chunks) assert.ok(bytes(c) <= MAX_MESSAGE_BYTES);
    assert.equal(squash(chunks.join('')), squash(text));
  });

  it('emoji / 代理对不会被切成半个码点', () => {
    const text = '🥚'.repeat(1200); // 每字 4B ≈4800B
    const chunks = splitMessage(text);
    for (const c of chunks) {
      assert.ok(bytes(c) <= MAX_MESSAGE_BYTES);
      assert.equal(c, '🥚'.repeat(c.length / 2), '块内应为完整 emoji');
    }
    assert.equal(chunks.join(''), text);
  });
});

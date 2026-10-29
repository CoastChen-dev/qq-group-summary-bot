/**
 * 基线：WebUI 请求体读取与启动防护。
 *
 * 锁定目标（2026-10）：① _body 在超 1MB / 客户端中断 / 读错误时都必须结算（旧实现只在
 * 'end' 结算，destroy 后 Promise 永久悬挂，每请求泄漏闭包）；② 非本机地址且未配 token
 * 时拒绝启动（管理面板不裸奔）；③ 本机 + 无 token 仍可用（保持原有本地体验）。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { WebUI } from '../../src/plugins/webui.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

/** 假请求：只需事件与 destroy */
function fakeReq() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; req.emit('close'); };
  return req;
}

describe('WebUI._body 请求体读取', () => {
  it('超过 1MB：立即结算为空对象并销毁请求（不悬挂）', async () => {
    const ui = new WebUI({});
    const req = fakeReq();
    const p = ui._body(req);
    req.emit('data', 'x'.repeat(1_000_001));
    assert.deepEqual(await p, {});
    assert.equal(req.destroyed, true);
  });

  it('客户端中断（close）：结算为空对象', async () => {
    const ui = new WebUI({});
    const req = fakeReq();
    const p = ui._body(req);
    req.emit('close');
    assert.deepEqual(await p, {});
  });

  it('正常 end：解析 JSON；坏 JSON 按空对象', async () => {
    const ui = new WebUI({});
    const ok = fakeReq();
    const p1 = ui._body(ok);
    ok.emit('data', '{"action":"deleteUser"}');
    ok.emit('end');
    assert.deepEqual(await p1, { action: 'deleteUser' });

    const bad = fakeReq();
    const p2 = ui._body(bad);
    bad.emit('data', '{坏');
    bad.emit('end');
    assert.deepEqual(await p2, {});
  });
});

describe('WebUI 启动防护', () => {
  it('非本机地址 + 未配 token：拒绝启动', () => {
    const ui = new WebUI({ host: '0.0.0.0', token: '' });
    assert.throws(() => ui.start({}), /token/);
  });

  it('本机地址 + 未配 token：允许启动（随机端口），可正常停服', async () => {
    const ui = new WebUI({ host: '127.0.0.1', port: 0 });
    ui.start({});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ui.server.listening, true);
    assert.ok(ui.server.address().port > 0);
    ui.stop();
  });
});

describe('WebUI 安全闸（2026-10）', () => {
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
      end(body) { this.body = body || ''; },
    };
  }

  function reqOf({ method = 'GET', url = '/api/status', headers = {}, body = '' } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; req.emit('close'); };
    if (body) process.nextTick(() => { req.emit('data', body); req.emit('end'); });
    else if (method === 'POST') process.nextTick(() => req.emit('end'));
    return req;
  }

  it('内联页不再用 onclick 拼接词条/群号（存储型 XSS 修复）', () => {
    const html = new WebUI({})._html();
    assert.ok(!html.includes('onclick="del'));
    assert.ok(html.includes('data-term='));
    assert.ok(html.includes('data-index='));
  });

  it('跨站 Origin 的写请求 → 403', async () => {
    const ui = new WebUI({});
    const res = fakeRes();
    await ui._handle(reqOf({
      method: 'POST',
      url: '/api/memory',
      headers: { host: '127.0.0.1:5210', origin: 'http://evil.example', 'content-type': 'application/json' },
      body: '{}',
    }), res);
    assert.equal(res.statusCode, 403);
  });

  it('非 JSON Content-Type 的 POST → 415', async () => {
    const ui = new WebUI({});
    const res = fakeRes();
    await ui._handle(reqOf({
      method: 'POST',
      url: '/api/memory',
      headers: { host: '127.0.0.1:5210', origin: 'http://127.0.0.1:5210', 'content-type': 'text/plain' },
      body: '{}',
    }), res);
    assert.equal(res.statusCode, 415);
  });

  it('未配 token 时非本机 Host（DNS rebinding）→ 403', async () => {
    const ui = new WebUI({});
    const res = fakeRes();
    await ui._handle(reqOf({ method: 'GET', url: '/api/status', headers: { host: 'evil.example' } }), res);
    assert.equal(res.statusCode, 403);
  });
});

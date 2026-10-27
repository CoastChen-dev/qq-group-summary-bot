/**
 * 基线：NapCatClient 的出站调用结算（call / _onMessage / 断线清理）。
 *
 * 覆盖点（2026-10 起：结算即清超时定时器；断线/关停时在途调用立刻 reject）：
 *   1. echo 关联正常响应 → resolve(data)、pending 清空；
 *   2. 服务端断开时在途调用快速失败（不等 15s 超时）——NapCat 挂掉时指令不会挂死；
 *   3. close() 后在途调用按「客户端已关闭」拒绝。
 * 用真 ws 服务端（ws 已是生产依赖），不触网。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import { NapCatClient } from '../../src/core/platform/napcat.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

/** 起一个本地 WS 服务端；handler(ws, msg) 处理调用帧，onConn(ws) 在新连接建立时执行 */
function mkServer(handler, onConn) {
  const wss = new WebSocketServer({ port: 0 });
  const sockets = new Set();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (raw) => handler(ws, JSON.parse(raw.toString())));
    onConn?.(ws);
  });
  return new Promise((resolve) => {
    wss.once('listening', () => resolve({
      port: wss.address().port,
      close: () => new Promise((r) => {
        for (const s of sockets) s.terminate();
        wss.close(() => r());
      }),
    }));
  });
}

/** 等客户端合成 lifecycle/connect（WS open 后自行派发，见 napcat.js connect） */
function waitConnect(client) {
  return new Promise((resolve) => {
    client.onEvent((e) => {
      if (e.meta_event_type === 'lifecycle' && e.sub_type === 'connect') resolve();
    });
  });
}

describe('NapCatClient 调用结算', () => {
  test('echo 关联响应：resolve(data)，pending 清空', async () => {
    const srv = await mkServer((ws, msg) => ws.send(JSON.stringify({
      echo: msg.echo, status: 'ok', retcode: 0, data: { action: msg.action, ok: true },
    })));
    const client = new NapCatClient(`ws://127.0.0.1:${srv.port}`, { reconnectDelay: 50 });
    try {
      const connected = waitConnect(client);
      client.connect();
      await connected;

      const data = await client.call('get_login_info');
      assert.deepEqual(data, { action: 'get_login_info', ok: true });
      assert.equal(client.pending.size, 0); // 结算后清出在途表
    } finally {
      client.close();
      await srv.close();
    }
  });

  test('sendGroupImage：文字 + base64 图片段（MAA 截图路径）', async () => {
    const frames = [];
    const srv = await mkServer((ws, msg) => {
      frames.push(msg);
      ws.send(JSON.stringify({ echo: msg.echo, status: 'ok', retcode: 0, data: { message_id: 1 } }));
    });
    const client = new NapCatClient(`ws://127.0.0.1:${srv.port}`, { reconnectDelay: 50 });
    try {
      const connected = waitConnect(client);
      client.connect();
      await connected;

      await client.sendGroupImage(123, Buffer.from([0x89, 0x50]), '【MAA 截图】');
      const message = frames[0].params.message;
      assert.equal(message[0].type, 'text');
      assert.equal(message[0].data.text, '【MAA 截图】');
      assert.equal(message[1].type, 'image');
      assert.ok(message[1].data.file.startsWith('base64://'));
    } finally {
      client.close();
      await srv.close();
    }
  });

  test('断线：在途调用立刻拒绝，不等 15s 超时', async () => {
    const srv = await mkServer((ws) => ws.close()); // 收到任何调用就断开
    const client = new NapCatClient(`ws://127.0.0.1:${srv.port}`, { reconnectDelay: 50 });
    try {
      const connected = waitConnect(client);
      client.connect();
      await connected;

      const t0 = Date.now();
      await assert.rejects(client.call('send_group_msg'), /断开|取消/);
      const cost = Date.now() - t0;
      assert.ok(cost < 2000, `应快速失败，实际 ${cost}ms`);
      assert.equal(client.pending.size, 0);
    } finally {
      client.close();
      await srv.close();
    }
  });

  test('close()：在途调用按「客户端已关闭」拒绝', async () => {
    const srv = await mkServer(() => { /* 不回复：制造在途调用 */ });
    const client = new NapCatClient(`ws://127.0.0.1:${srv.port}`, { reconnectDelay: 50 });
    try {
      const connected = waitConnect(client);
      client.connect();
      await connected;

      const inflight = client.call('slow_action');
      const settled = assert.rejects(inflight, /已关闭|取消/);
      client.close();
      await settled;
      assert.equal(client.pending.size, 0);
    } finally {
      await srv.close();
    }
  });
});

describe('NapCatClient 重连退避', () => {
  test('连上就断：退避不复位，延迟逐次翻倍（3s 高频重连回归）', async () => {
    // 每次连接 20ms 后就断：模拟 NapCat 反复重启/鉴权失败时「连上即断」
    const srv = await mkServer(() => {}, (ws) => setTimeout(() => ws.close(), 20));
    const client = new NapCatClient(`ws://127.0.0.1:${srv.port}`, {
      reconnectDelay: 20, maxReconnectDelay: 200, resetBackoffAfterMs: 10000,
    });
    const delaysAtOpen = [];
    client.onEvent((e) => {
      if (e.meta_event_type === 'lifecycle' && e.sub_type === 'connect') delaysAtOpen.push(client._curDelay);
    });
    client.connect();
    try {
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(delaysAtOpen.length >= 3, `应至少重连两次，实际 ${delaysAtOpen.length} 次`);
      // 旧实现 open 即复位 → 每次都是 20；新实现 20→40→80
      assert.ok(delaysAtOpen[2] > delaysAtOpen[0], `退避应增长，实际 ${delaysAtOpen.join('→')}`);
    } finally {
      client.close();
      await srv.close();
    }
  });

  test('连接稳定超过 resetBackoffAfterMs：退避复位到起点', async () => {
    const srv = await mkServer(() => { /* 保持连接 */ });
    const client = new NapCatClient(`ws://127.0.0.1:${srv.port}`, { reconnectDelay: 20, resetBackoffAfterMs: 60 });
    client._curDelay = 160; // 模拟此前已退避到 160ms
    try {
      const connected = waitConnect(client);
      client.connect();
      await connected;
      await new Promise((r) => setTimeout(r, 140));
      assert.equal(client._curDelay, 20); // 稳定 60ms 后复位
    } finally {
      client.close();
      await srv.close();
    }
  });
});

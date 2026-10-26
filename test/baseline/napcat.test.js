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

/** 起一个本地 WS 服务端；handler(ws, msg, raw) 决定怎么回 */
function mkServer(handler) {
  const wss = new WebSocketServer({ port: 0 });
  const sockets = new Set();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (raw) => handler(ws, JSON.parse(raw.toString())));
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

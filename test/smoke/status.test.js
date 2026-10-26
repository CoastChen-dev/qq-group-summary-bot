/**
 * 冒烟：NapCat 平台状态指令（plugins/status.js）。
 *
 * 覆盖：整串锚定匹配（#status / /status / 大小写；非整串/其他指令不误吞）、异步三接口
 * 汇总与真 @ 发送、单接口失败降级、三接口全失败与无 client 的兜底文案。使用 fake client，
 * 零网络（真实接口形状已按服务器 NapCat 4.18.37 的返回核对）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PluginRegistry } from '../../src/core/registry.js';
import { createStatusPlugin } from '../../src/plugins/status.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makeClient(overrides = {}) {
  const sent = [];
  const calls = [];
  return {
    selfId: 3663374673,
    ws: { readyState: 1 },
    sent,
    calls,
    async call(action) {
      calls.push(action);
      const v = overrides[action];
      if (v instanceof Error) throw v;
      if (v !== undefined) return v;
      if (action === 'get_login_info') return { user_id: 3663374673, nickname: 'Mon3tr' };
      if (action === 'get_version_info') return { app_name: 'NapCat.Onebot', app_version: '4.18.37', protocol_version: 'v11' };
      if (action === 'get_status') return { online: true, good: true, stat: {} };
      throw new Error(`unexpected action: ${action}`);
    },
    async sendGroupMsgAt(gid, uid, msg) { sent.push({ gid, at: String(uid), msg }); },
    async sendGroupMsg(gid, msg) { sent.push({ gid, msg }); },
  };
}

function dispatch(text, client) {
  const reg = new PluginRegistry();
  reg.register(createStatusPlugin());
  return reg.dispatch({ text, client, groupId: 9, userId: 555 });
}

describe('status 插件（NapCat 平台信息）', () => {
  it('整串锚定：#status 与 /status 命中，其余文本让位', () => {
    for (const t of ['#status', '/status', ' #STATUS ', '/Status']) {
      assert.equal(dispatch(t, makeClient()), true, t);
    }
    for (const t of ['status', '#statusx', '/status 现在', '状态', '', '查干员 #status']) {
      assert.equal(dispatch(t, makeClient()), null, t);
    }
  });

  it('命中后并发查询三接口，汇总平台信息并真 @ 提问者', async () => {
    const client = makeClient();
    assert.equal(dispatch('#status', client), true);
    assert.deepEqual(client.calls, ['get_login_info', 'get_version_info', 'get_status']); // 同步发起
    await tick();
    assert.equal(client.sent.length, 1);
    const { gid, at, msg } = client.sent[0];
    assert.equal(gid, 9);
    assert.equal(at, '555');
    assert.match(msg, /【NapCat 平台状态】/);
    assert.match(msg, /账号：3663374673（Mon3tr）/);
    assert.match(msg, /平台：NapCat\.Onebot v4\.18\.37/);
    assert.match(msg, /协议：OneBot 11（v11）/);
    assert.match(msg, /状态：在线 \/ 正常/);
    assert.match(msg, /WS：已连接/);
    assert.match(msg, /接口：3\/3 正常/);
    assert.match(msg, /查询耗时：\d+ ms/);
    assert.match(msg, /Bot 运行时长：/);
  });

  it('单接口失败不影响整体：该行降级为未知、接口计数 2/3', async () => {
    const client = makeClient({ get_version_info: new Error('boom') });
    dispatch('/status', client);
    await tick();
    assert.equal(client.sent.length, 1);
    assert.match(client.sent[0].msg, /平台：NapCat v未知/);
    assert.match(client.sent[0].msg, /协议：OneBot 11\n/);
    assert.match(client.sent[0].msg, /接口：2\/3 正常/);
  });

  it('三个接口全失败：仍回一条「未知」状态，不抛不吞', async () => {
    const client = makeClient({
      get_login_info: new Error('down'),
      get_version_info: new Error('down'),
      get_status: new Error('down'),
    });
    dispatch('#status', client);
    await tick();
    assert.equal(client.sent.length, 1);
    assert.match(client.sent[0].msg, /账号：3663374673/); // selfId 兜底
    assert.match(client.sent[0].msg, /状态：未知 \/ 未知/);
    assert.match(client.sent[0].msg, /接口：0\/3 正常/);
  });

  it('无 client / client 不支持 call：返回可发送的降级文案', () => {
    assert.match(dispatch('#status', null), /客户端未注入/);
    assert.match(dispatch('#status', {}), /客户端未注入/);
  });
});

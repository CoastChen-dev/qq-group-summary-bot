/**
 * 冒烟：MAA 指令插件（权限门、指令解析、任务提交与完成回执）。
 *
 * 用假 bridge（不发网络、不拉 Python）锁行为：只有主人能下指令、整串锚定、刷图/公招参数、
 * 提交后 ack + 后台轮询到 done 再发结果（含掉落汇总）、busy 提示、状态/停止。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMaaPlugin } from '../../src/plugins/maa.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 bridge：可配置 submit 行为与任务终态 */
function mkBridge({ jobState = 'done', submitError = null, status = {}, screenshot = null } = {}) {
  const calls = { submit: [], job: 0, stop: 0, screenshot: 0, connect: 0 };
  return {
    calls,
    baseUrl: 'http://stub',
    async start() {},
    close() {},
    async status() {
      return { ok: true, version: 'v6.20.1', connected: true, running: false, job: null, last_error: '', ...status };
    },
    async submitMany(tasks) {
      if (submitError) throw submitError;
      calls.submit.push(tasks);
      return { job_id: 'j1' };
    },
    async submit(type, params) {
      return this.submitMany([{ type, params }]);
    },
    async connect() { calls.connect++; return { ok: true, connected: true }; },
    async job() {
      calls.job++;
      return { id: 'j1', state: jobState, elapsed: 65, drops: { 龙门币: 5 }, chains: ['Fight'], error: '' };
    },
    async stop() { calls.stop++; },
    async screenshot() {
      calls.screenshot++;
      if (!screenshot) throw Object.assign(new Error('截图失败'), { status: 503 });
      return screenshot;
    },
  };
}

/** 假 NapCat 客户端：记录发往哪里 */
function mkClient() {
  const sent = [];
  return {
    sent,
    sendGroupMsg: async (gid, msg) => { sent.push({ gid, msg }); },
    sendGroupMsgAt: async (gid, uid, msg) => { sent.push({ gid, uid, msg }); },
    sendGroupImage: async (gid, png, caption) => { sent.push({ gid, png, caption }); },
  };
}

function mkPlugin(opts = {}) {
  const bridge = opts.bridge || mkBridge();
  const client = opts.client || mkClient();
  const plugin = createMaaPlugin({
    bridge, client, ownerId: opts.ownerId ?? 10001,
    allowGacha: opts.allowGacha, gachaConfirmMs: opts.gachaConfirmMs,
    pollIntervalMs: 5, taskTimeoutMs: 5000,
  });
  return { plugin, bridge, client, sent: client.sent };
}

const ctx = (text, userId = 10001) => ({ groupId: 9, userId, text });

describe('MAA 指令插件：权限门', () => {
  it('非主人：拒绝，且不提交任务', () => {
    const { plugin, bridge } = mkPlugin();
    assert.match(plugin.handleMessage(ctx('maa 刷图 CE-6 5', 999)), /只有主人/);
    assert.equal(bridge.calls.submit.length, 0);
  });

  it('未配置主人：整域禁用', () => {
    const { plugin } = mkPlugin({ ownerId: 0 });
    assert.match(plugin.handleMessage(ctx('maa 状态')), /未配置主人/);
  });

  it('非 maa 文本不认领（交给 chat 兜底）', () => {
    const { plugin } = mkPlugin();
    assert.equal(plugin.handleMessage(ctx('今天刷什么图')), null);
  });
});

describe('MAA 指令插件：指令解析与回执', () => {
  it('帮助', () => {
    const { plugin } = mkPlugin();
    const r = plugin.handleMessage(ctx('maa 帮助'));
    assert.match(r, /maa 刷图 <关卡> \[次数\]/);
  });

  it('刷图：提交 Fight{stage,times}，ack 后轮询到 done 发掉落汇总', async () => {
    const { plugin, bridge, sent } = mkPlugin();
    assert.equal(plugin.handleMessage(ctx('maa 刷图 CE-6 5')), true);
    await tick(60); // 等 submit → ack → 轮询（5ms）→ 完成回执
    assert.deepEqual(bridge.calls.submit, [[{ type: 'Fight', params: { stage: 'CE-6', times: 5, client_type: 'Official' } }]]);
    assert.equal(sent[0].uid, 10001); // 回执真 @ 主人
    assert.match(sent[0].msg, /刷图 CE-6 ×5 已开始/);
    assert.match(sent[1].msg, /刷图 CE-6 ×5 完成（1 分 5 秒）/);
    assert.match(sent[1].msg, /龙门币×5/);
  });

  it('唤醒：StartUp 带上 clientType（B 服/官服决定启动哪个包）', async () => {
    const bridge = mkBridge();
    const client = mkClient();
    const plugin = createMaaPlugin({
      bridge, client, ownerId: 10001, clientType: 'Bilibili', pollIntervalMs: 5, taskTimeoutMs: 5000,
    });
    plugin.handleMessage(ctx('maa 唤醒'));
    await tick(40);
    assert.deepEqual(bridge.calls.submit[0], [{ type: 'StartUp', params: { client_type: 'Bilibili' } }]);
    assert.match(client.sent[0].msg, /启动游戏 已开始/);
  });

  it('公招：默认 4 次，参数走 Recruit select/confirm', async () => {
    const { plugin, bridge, sent } = mkPlugin();
    plugin.handleMessage(ctx('maa 公招'));
    await tick(40);
    assert.deepEqual(bridge.calls.submit, [[{ type: 'Recruit', params: { select: [4], confirm: [3, 4], times: 4 } }]]);
    assert.match(sent[1].msg, /公招 ×4 完成/);
  });

  it('刷图缺关卡：只回用法，不提交', () => {
    const { plugin, bridge } = mkPlugin();
    assert.match(plugin.handleMessage(ctx('maa 刷图')), /用法/);
    assert.equal(bridge.calls.submit.length, 0);
  });

  it('busy（409）：提示已有任务在跑', async () => {
    const err = Object.assign(new Error('busy'), { status: 409 });
    const { plugin, sent } = mkPlugin({ bridge: mkBridge({ submitError: err }) });
    plugin.handleMessage(ctx('maa 刷图 CE-6'));
    await tick(30);
    assert.match(sent[0].msg, /已有任务在跑/);
  });

  it('状态：异步查询并真 @', async () => {
    const { plugin, sent } = mkPlugin();
    plugin.handleMessage(ctx('maa 状态'));
    await tick(20);
    assert.match(sent[0].msg, /MaaCore：v6\.20\.1/);
    assert.match(sent[0].msg, /设备：已连接/);
    assert.equal(sent[0].uid, 10001);
  });

  it('截图：取图并作为图片消息发到群（带说明）', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { plugin, sent, bridge } = mkPlugin({ bridge: mkBridge({ screenshot: png }) });
    assert.equal(plugin.handleMessage(ctx('maa 截图')), true);
    await tick(20);
    assert.equal(bridge.calls.screenshot, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].png, png);
    assert.match(sent[0].caption, /MAA 截图/);
  });

  it('截图失败：提示原因', async () => {
    const { plugin, sent } = mkPlugin(); // 默认 bridge.screenshot 抛 503
    plugin.handleMessage(ctx('maa 截图'));
    await tick(20);
    assert.match(sent[0].msg, /截图失败/);
  });

  it('日常：默认 5 个任务链；带关卡则把 Fight 插到唤醒之后', async () => {
    const { plugin, bridge } = mkPlugin();
    plugin.handleMessage(ctx('maa 日常'));
    await tick(30);
    assert.deepEqual(bridge.calls.submit[0].map((t) => t.type), ['StartUp', 'Recruit', 'Infrast', 'Mall', 'Award']);

    const b2 = mkBridge();
    const p2 = createMaaPlugin({ bridge: b2, client: mkClient(), ownerId: 10001, pollIntervalMs: 5 });
    p2.handleMessage(ctx('maa 日常 CE-6 3'));
    await tick(30);
    const tasks = b2.calls.submit[0];
    assert.deepEqual(tasks.map((t) => t.type), ['StartUp', 'Fight', 'Recruit', 'Infrast', 'Mall', 'Award']);
    assert.deepEqual(tasks[1].params, { stage: 'CE-6', times: 3, client_type: 'Official' });
  });

  it('领奖励 / 信用 / 关闭 / 自定义 / 重连', async () => {
    const { plugin, bridge, sent } = mkPlugin();
    plugin.handleMessage(ctx('maa 领奖励'));
    await tick(20);
    assert.equal(bridge.calls.submit[0][0].type, 'Award');

    plugin.handleMessage(ctx('maa 信用 招聘许可、龙门币'));
    await tick(20);
    assert.deepEqual(bridge.calls.submit[1][0].params.buy_first, ['招聘许可', '龙门币']);

    plugin.handleMessage(ctx('maa 关闭'));
    await tick(20);
    assert.equal(bridge.calls.submit[2][0].type, 'CloseDown');

    plugin.handleMessage(ctx('maa 自定义 Award Fight'));
    await tick(20);
    assert.deepEqual(bridge.calls.submit[3][0], { type: 'Custom', params: { task_names: ['Award', 'Fight'] } });

    plugin.handleMessage(ctx('maa 重连'));
    await tick(20);
    assert.equal(bridge.calls.connect, 1);
    assert.match(sent.at(-1).msg, /已重新连接设备/);
  });

  it('真抽卡默认关闭：allowGacha=false 时直接拒绝，不提交', () => {
    const { plugin, bridge } = mkPlugin();
    const r = plugin.handleMessage(ctx('maa 抽卡十连'));
    assert.match(r, /真抽卡未启用/);
    assert.equal(bridge.calls.submit.length, 0);
  });

  it('真抽卡：先要确认，确认后才提交 Custom 链，结束后补结果截图', async () => {
    const png = Buffer.from([0x89, 0x50]);
    const { plugin, bridge, sent } = mkPlugin({ allowGacha: true, bridge: mkBridge({ screenshot: png }) });
    const prompt = plugin.handleMessage(ctx('maa 抽卡十连'));
    assert.match(prompt, /确认要执行「真抽卡·十连」/);
    assert.match(prompt, /6000 合成玉/);
    assert.equal(bridge.calls.submit.length, 0); // 未确认前不动手

    assert.equal(plugin.handleMessage(ctx('maa 确认')), true);
    await tick(60);
    assert.deepEqual(bridge.calls.submit[0], [
      { type: 'StartUp', params: { client_type: 'Official' } },
      { type: 'Custom', params: { task_names: ['GachaTenTimes'] } },
    ]);
    assert.match(sent[0].msg, /真抽卡·十连 已开始/);
    assert.match(sent[1].msg, /真抽卡·十连 完成/);
    assert.equal(sent[2].png, png); // 结果截图
  });

  it('抽卡取消与过期：取消后不能再确认；超时确认报过期', async () => {
    const p = mkPlugin({ allowGacha: true, gachaConfirmMs: 60000 });
    assert.match(p.plugin.handleMessage(ctx('maa 抽卡单抽')), /600 合成玉/);
    assert.match(p.plugin.handleMessage(ctx('maa 取消')), /已取消/);
    assert.match(p.plugin.handleMessage(ctx('maa 确认')), /没有待确认/);

    const q = mkPlugin({ allowGacha: true, gachaConfirmMs: 1 });
    q.plugin.handleMessage(ctx('maa 抽卡单抽'));
    await tick(10);
    assert.match(q.plugin.handleMessage(ctx('maa 确认')), /已过期/);
    assert.equal(q.bridge.calls.submit.length, 0);
  });

  it('停止：调用 bridge.stop 并回执', async () => {
    const { plugin, bridge, sent } = mkPlugin();
    plugin.handleMessage(ctx('maa 停止'));
    await tick(20);
    assert.equal(bridge.calls.stop, 1);
    assert.match(sent[0].msg, /已发送停止指令/);
  });

  it('失败任务：结果文案标明失败与原因', async () => {
    const bridge = mkBridge({ jobState: 'error' });
    bridge.job = async () => ({ id: 'j1', state: 'error', elapsed: 10, drops: {}, chains: [], error: 'adb 断开' });
    const { plugin, sent } = mkPlugin({ bridge });
    plugin.handleMessage(ctx('maa 唤醒'));
    await tick(50);
    assert.match(sent[1].msg, /启动游戏 失败/);
    assert.match(sent[1].msg, /原因：adb 断开/);
  });
});

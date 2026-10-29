/**
 * P3b 冒烟：后台/服务插件（summary/refresh/report——原 runtime 三个后台流程迁出后与 registry
 * 的契约面）。服务与配置全部 fake 注入（createXxxPlugin(deps) 的注入面即断言面），分发经真实
 * PluginRegistry 走（priority/短路语义与运行时一致）。
 *
 * 锁定面：summary 关键词命中返回 true 且概括异步执行（含 per-group 互斥、三守卫、ready 静默
 * 消费）；refresh 整串锚定正则与 ack/失败路径、updated 非空 → 清一次 q:* 知识缓存（2026-09
 * 修复坑 3，updated 空不触发）、hooks.start 定时器真实触发一次后 hooks.stop
 * 清理（防残留 interval 挂起进程）；report 无消息面（dispatch 恒 null）、hooks.start 注册的
 * 9:00 回调可驱动完整日报、hooks.stop 停调度。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PluginRegistry } from '../../src/core/registry.js';
import { createSummaryPlugin } from '../../src/plugins/summary.js';
import { createRefreshPlugin } from '../../src/plugins/refresh.js';
import { createReportPlugin } from '../../src/plugins/report.js';
import { cleanupTmpDirs, makeTmp, silenceLog } from '../helpers.js';

after(silenceLog());
after(cleanupTmpDirs);

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// 敏感过滤原样放行（enabled 开关由 runtime 包装，插件只消费包装结果）
const passThrough = (recs) => ({ kept: recs, filtered: [] });

describe('summary 插件（手动总结，原 S8）', () => {
  function mkSummary({ msgs = [{ time: Math.floor(Date.now() / 1000) }], summarize, ready = true } = {}) {
    const sent = [];
    const calls = { summarize: 0, setLast: 0 };
    const store = {
      getLastSummaryAt: () => 0,
      collectSince: () => msgs,
      setLastSummaryAt: () => { calls.setLast++; },
    };
    const plugin = createSummaryPlugin({
      store,
      client: { sendGroupMsg: async (gid, msg) => sent.push({ gid, msg }) },
      summarizer: { summarize: async (...a) => { calls.summarize++; return (summarize ? await summarize(...a) : '概括文本'); } },
      filterMessages: passThrough,
      minMessages: 1,
      manualCmds: ['总结', '/总结', '#总结'],
      isReady: () => ready,
    });
    const reg = new PluginRegistry();
    reg.register(plugin);
    return { reg, sent, calls };
  }

  it('关键词命中：返回 true 消费消息，概括异步群发并推进 lastSummaryAt', async () => {
    const { reg, sent, calls } = mkSummary();
    assert.equal(reg.dispatch({ groupId: 1, text: '总结一下今天' }), true);
    // 不 await 完成（fire-and-forget）：本测试只断言最终恰好执行一次
    await tick();
    assert.equal(calls.summarize, 1);
    assert.equal(calls.setLast, 1); // 发送成功后才推进
    assert.equal(sent.length, 1);
    assert.ok(sent[0].msg.startsWith('【群聊概括】'), sent[0].msg);
  });

  it('未命中（无关键词）返回 null；纯 @/刷新类文本不受影响', () => {
    const { reg } = mkSummary();
    assert.equal(reg.dispatch({ groupId: 1, text: '波登可是谁' }), null);
    assert.equal(reg.dispatch({ groupId: 1, text: '刷新数据' }), null); // 刷新归 refresh 带
    assert.equal(reg.dispatch({ groupId: 1, text: '' }), null);
  });

  it('ready=false：命中仍返回 true（消息被消费）但静默跳过执行', async () => {
    const { reg, calls, sent } = mkSummary({ ready: false });
    assert.equal(reg.dispatch({ groupId: 1, text: '总结' }), true);
    await tick();
    assert.equal(calls.summarize, 0);
    assert.equal(sent.length, 0);
  });

  it('per-group 互斥：概括进行中重复指令被忽略（risk #2），他群不受影响', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { reg, sent, calls } = mkSummary({ summarize: async () => { await gate; return '慢概括'; } });
    assert.equal(reg.dispatch({ groupId: 7, text: '总结' }), true);
    assert.equal(reg.dispatch({ groupId: 7, text: '/总结' }), true); // 进行中：忽略
    assert.equal(reg.dispatch({ groupId: 8, text: '总结' }), true); // 他群不受互斥影响
    release();
    await tick(40);
    assert.equal(calls.summarize, 2); // 群7 一次 + 群8 一次
    assert.equal(sent.length, 2);
  });

  it('守卫：无消息时跳过（不调 LLM、不群发）', async () => {
    const { reg, calls, sent } = mkSummary({ msgs: [] });
    assert.equal(reg.dispatch({ groupId: 1, text: '总结' }), true);
    await tick();
    assert.equal(calls.summarize, 0);
    assert.equal(sent.length, 0);
  });
});

describe('refresh 插件（手动刷新 + 自动定时器，原 S11/§6.3）', () => {
  function mkRefresh({ announce = false, tracked = [], updated = ['干员数据'] } = {}) {
    const sent = [];
    const calls = { reload: 0, refresh: 0, clearCache: 0 };
    const store = { trackedGroupIds: () => [] };
    const plugin = createRefreshPlugin({
      arkdb: {
        snapshotHighOps: () => [],
        snapshotGachaPools: () => [],
        reload: () => { calls.reload++; },
      },
      refresher: { refresh: async () => { calls.refresh++; return { updated, unchanged: [], failed: [] }; } },
      cache: { deleteByPrefix: (prefix) => { assert.equal(prefix, 'q:'); calls.clearCache++; return 1; } },
      client: { sendGroupMsg: async (gid, msg) => { sent.push({ gid, msg }); } },
      store,
      trackedGroups: () => tracked,
      broadcast: announce,
      schedule: {},
    });
    const reg = new PluginRegistry();
    reg.register(plugin);
    return { plugin, reg, sent, calls };
  }

  it('整串锚定命中：返回 true + ack，完成后回执【数据更新】并热重载', async () => {
    const { reg, sent, calls } = mkRefresh();
    assert.equal(reg.dispatch({ groupId: 1, text: '刷新数据' }), true);
    await tick(40);
    assert.equal(calls.refresh, 1);
    assert.equal(calls.reload, 1); // updated 非空 → arkdb.reload()
    assert.deepEqual(sent.map((s) => s.gid), [1, 1]);
    assert.equal(sent[0].msg, '正在更新本地数据库，稍候…'); // ack 先于结果
    assert.ok(sent[1].msg.startsWith('【数据更新】'), sent[1].msg);
    assert.ok(!sent.some((s) => s.msg.includes('播报'))); // broadcast=false 无播报
  });

  it('并发触发单飞：两个群同时刷新只下载一次，各自收到结果回执', async () => {
    const sent = [];
    let release;
    let downloads = 0;
    const plugin = createRefreshPlugin({
      arkdb: { snapshotHighOps: () => [], snapshotGachaPools: () => [], reload: () => {} },
      refresher: {
        refresh: () => {
          downloads++;
          return new Promise((resolve) => {
            release = () => resolve({ updated: [], unchanged: ['干员表'], failed: [] });
          });
        },
      },
      cache: { deleteByPrefix: () => 0 },
      client: {
        sendGroupMsg: async (gid, msg) => { sent.push({ gid, msg }); },
        sendGroupMsgAt: async (gid, uid, msg) => { sent.push({ gid, uid, msg }); },
      },
      store: { trackedGroupIds: () => [] },
      trackedGroups: () => [],
      broadcast: false,
      schedule: {},
    });
    const p1 = plugin.api.refresh(111, 9);
    const p2 = plugin.api.refresh(222, 9);
    assert.equal(downloads, 1); // 第二次触发不再下载，挂到同一个任务上
    release();
    const [m1, m2] = await Promise.all([p1, p2]);
    assert.equal(downloads, 1);
    assert.equal(m1, m2);
    assert.deepEqual(sent.map((s) => s.gid), [111, 222]); // 两个群各收到一条结果回执
    assert.ok(sent.every((s) => s.msg.startsWith('【数据更新】')));
  });

  it('数据有更新 → 恰清一次 q:* 知识检索缓存（坑 3：deleteByPrefix 只收 q:）', async () => {
    const { reg, calls } = mkRefresh();
    reg.dispatch({ groupId: 1, text: '刷新数据' });
    await tick(40);
    assert.equal(calls.clearCache, 1); // updated 非空 → 清缓存恰 1 次（与 reload 同步）
  });

  it('数据无变化（updated 空）：不热重载也不清缓存（坑 3：失效只在真有更新时）', async () => {
    const { reg, calls } = mkRefresh({ updated: [] });
    reg.dispatch({ groupId: 1, text: '刷新数据' });
    await tick(40);
    assert.equal(calls.reload, 0);
    assert.equal(calls.clearCache, 0);
  });

  it('非整串（前缀/近似词）不命中：刷新数据库、帮我刷新数据 → null', () => {
    const { reg } = mkRefresh();
    assert.equal(reg.dispatch({ groupId: 1, text: '刷新数据库' }), null);
    assert.equal(reg.dispatch({ groupId: 1, text: '帮我刷新数据' }), null);
    assert.equal(reg.dispatch({ groupId: 1, text: '更新一下数据库' }), null);
  });

  it('hooks.start 定时器真实触发一次自动更新（broadcast 到跟踪群），hooks.stop 清理防残留', async () => {
    const sent = [];
    // 快照随 reload 演化：reload 前无干员、reload 后出现新 6★ → 自动更新播报才有内容
    let loaded = false;
    let cleared = 0;
    const plugin = createRefreshPlugin({
      arkdb: {
        snapshotHighOps: () => (loaded ? [{ id: 'op1', name: '新干员', rarity: 'TIER_6' }] : []),
        snapshotGachaPools: () => [],
        reload: () => { loaded = true; },
      },
      refresher: { refresh: async () => ({ updated: ['干员数据'], unchanged: [], failed: [] }) },
      cache: { deleteByPrefix: () => { cleared++; return 1; } }, // 坑 3：自动更新同样清 q:* 缓存
      client: { sendGroupMsg: async (gid, msg) => sent.push({ gid, msg }) },
      store: { trackedGroupIds: () => [] },
      trackedGroups: () => [111, 222],
      broadcast: true,
      schedule: { firstDelayMinutes: 0.001 }, // 首延 60ms（真实触发自动更新）
    });
    const reg = new PluginRegistry();
    reg.register(plugin);
    plugin.hooks.start();
    assert.equal(sent.length, 0); // 首延未到，不触发
    await tick(150);
    assert.equal(sent.length, 2, `自动更新应广播到两个跟踪群，实收 ${sent.length}`);
    assert.ok(sent.every((s) => [111, 222].includes(s.gid)));
    assert.ok(sent.some((s) => s.msg.includes('新增 6★ 干员：新干员')));
    assert.equal(cleared, 1); // 自动刷新 updated 非空 → 清缓存一次
    plugin.hooks.stop(); // 清掉 repeat interval（24h），防残留定时器挂起进程
  });
});

describe('report 插件（每日日报，仅 hooks）', () => {
  it('无消息面：dispatch 恒 null（不占任何分发带）', () => {
    const scheduler = { start: () => {}, stop: () => {} };
    const plugin = createReportPlugin({
      store: { loadFromDisk: () => {}, collectRange: () => [] },
      client: {},
      summarizer: { summarize: async () => '' },
      scheduler,
      filterMessages: passThrough,
      trackedGroups: () => [],
      getAllGroupIds: async () => [1],
      reportUserId: 9,
      reportMinMessages: 100,
      isReady: () => true,
    });
    const reg = new PluginRegistry();
    reg.register(plugin);
    assert.equal(reg.dispatch({ groupId: 1, text: '总结' }), null);
    assert.equal(reg.dispatch({ groupId: 1, text: '刷新数据' }), null);
  });

  it('hooks.start 注册 9:00 回调；回调驱动完整日报（合并转发：标题+每群一节点）；hooks.stop 停调度', async () => {
    let run;
    let stopped = false;
    const sent = [];
    const plugin = createReportPlugin({
      store: {
        loadFromDisk: () => {},
        collectRange: () => [{ time: Math.floor(Date.now() / 1000), text: '摸鱼' }],
      },
      client: {
        selfId: 12345,
        getGroupInfo: async () => ({ group_name: '测试群' }),
        sendPrivateForward: async (uid, nodes) => sent.push({ uid, nodes }),
        sendPrivateMsg: async (uid, msg) => sent.push({ uid, msg }), // 兜底路径（本用例不应触发）
      },
      summarizer: { summarize: async () => '日报内容' },
      scheduler: { start: (fn) => { run = fn; }, stop: () => { stopped = true; } },
      filterMessages: passThrough,
      trackedGroups: () => [1],
      getAllGroupIds: async () => { throw new Error('不应走到 getAllGroupIds'); },
      reportUserId: 9,
      reportMinMessages: 1,
      isReady: () => true,
    });
    const reg = new PluginRegistry();
    reg.register(plugin);

    plugin.hooks.start();
    assert.equal(typeof run, 'function'); // scheduler.start(dailyReport) 已注册
    await run();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].uid, 9);
    assert.ok(Array.isArray(sent[0].nodes)); // 走合并转发而非纯文本
    assert.equal(sent[0].nodes.length, 2); // 标题节点 + 测试群节点
    assert.ok(sent[0].nodes[0].data.content.startsWith('【昨日群聊日报'), sent[0].nodes[0].data.content);
    assert.equal(sent[0].nodes[1].data.name, '测试群'); // getGroupName 走 client.getGroupInfo
    assert.ok(sent[0].nodes[1].data.content.includes('日报内容'));

    plugin.hooks.stop();
    assert.equal(stopped, true);
  });

  it('日报合并转发失败：回退整条私聊文本', async () => {
    let run;
    const sent = [];
    const plugin = createReportPlugin({
      store: {
        loadFromDisk: () => {},
        collectRange: () => [{ time: Math.floor(Date.now() / 1000), text: '摸鱼' }],
      },
      client: {
        selfId: 1,
        getGroupInfo: async () => ({ group_name: '测试群' }),
        sendPrivateForward: async () => { throw new Error('forward 不可用'); },
        sendPrivateMsg: async (uid, msg) => sent.push({ uid, msg }),
      },
      summarizer: { summarize: async () => '日报内容' },
      scheduler: { start: (fn) => { run = fn; }, stop: () => {} },
      filterMessages: passThrough,
      trackedGroups: () => [1],
      getAllGroupIds: async () => [1],
      reportUserId: 9,
      reportMinMessages: 1,
      isReady: () => true,
    });
    plugin.hooks.start();
    await run();
    assert.equal(sent.length, 1);
    assert.ok(sent[0].msg.startsWith('【昨日群聊日报'), sent[0].msg);
    assert.ok(sent[0].msg.includes('测试群') && sent[0].msg.includes('日报内容'));
  });

  it('日报后提炼情节记忆并落库（日期=昨日标签）', async () => {
    let run;
    const saved = [];
    const sent = [];
    const plugin = createReportPlugin({
      store: { loadFromDisk: () => {}, collectRange: () => [{ time: Math.floor(Date.now() / 1000), text: '摸鱼' }] },
      client: {
        selfId: 1,
        getGroupInfo: async () => ({ group_name: '测试群' }),
        sendPrivateForward: async (uid, nodes) => sent.push({ uid, nodes }),
        sendPrivateMsg: async () => {},
      },
      summarizer: { summarize: async () => '日报内容', extractMemories: async () => ['小王在玩方舟', '周六开黑'] },
      scheduler: { start: (fn) => { run = fn; }, stop: () => {} },
      filterMessages: passThrough,
      trackedGroups: () => [1],
      getAllGroupIds: async () => [1],
      episodic: { save: (gid, date, items) => saved.push({ gid, date, items }) },
      reportUserId: 9,
      reportMinMessages: 1,
      isReady: () => true,
    });
    plugin.hooks.start();
    await run();
    assert.equal(sent.length, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].gid, 1);
    assert.match(saved[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(saved[0].items, ['小王在玩方舟', '周六开黑']);
  });

  it('月初跨月：昨日标签取上月末一天，不出现 00 日（2026-11-01 → 2026-10-31）', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 1, 9, 0, 0) }); // 11 月 1 日 9:00
    let run;
    const seenLabels = [];
    const plugin = createReportPlugin({
      store: {
        loadFromDisk: () => {},
        collectRange: () => [{ time: Math.floor(Date.now() / 1000), text: '摸鱼' }],
      },
      client: {
        selfId: 1,
        getGroupInfo: async () => ({ group_name: '测试群' }),
        sendPrivateForward: async () => {},
        sendPrivateMsg: async () => {},
      },
      summarizer: { summarize: async (gid, recs, day) => { seenLabels.push(day); return '日报内容'; } },
      scheduler: { start: (fn) => { run = fn; }, stop: () => {} },
      filterMessages: passThrough,
      trackedGroups: () => [1],
      getAllGroupIds: async () => [1],
      reportUserId: 9,
      reportMinMessages: 1,
      isReady: () => true,
    });
    plugin.hooks.start();
    await run();
    assert.deepEqual(seenLabels, ['2026-10-31']); // 旧实现会算出 2026-11-00
  });
});

describe('summary 概括窗口上限（2026-10）', () => {
  it('上次总结早于 maxWindowHours：只回读最近窗口，避免同步读回几万行', async () => {
    const loaded = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const plugin = createSummaryPlugin({
      store: {
        getLastSummaryAt: () => nowSec - 10 * 86400,
        loadFromDisk: (gid, since) => loaded.push(since),
        collectSince: () => [], // 窗口内无消息：只看 loadFromDisk 的起点
        setLastSummaryAt: () => {},
      },
      client: { sendGroupMsg: async () => {} },
      summarizer: { summarize: async () => 'x' },
      filterMessages: passThrough,
      minMessages: 1,
      manualCmds: ['总结'],
      maxWindowHours: 72,
      isReady: () => true,
    });
    const reg = new PluginRegistry();
    reg.register(plugin);
    assert.equal(reg.dispatch({ groupId: 3, text: '总结' }), true);
    await tick();
    assert.equal(loaded.length, 1);
    assert.ok(loaded[0] >= nowSec - 72 * 3600 - 2, `窗口起点应被压到 72h 内，实际 ${loaded[0]}`);
    assert.ok(loaded[0] <= nowSec - 72 * 3600 + 2);
  });

  it('窗口在 maxWindowHours 内：保持原有「从上次总结起」语义', async () => {
    const loaded = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const since = nowSec - 3 * 3600;
    const plugin = createSummaryPlugin({
      store: {
        getLastSummaryAt: () => since,
        loadFromDisk: (gid, s) => loaded.push(s),
        collectSince: () => [],
        setLastSummaryAt: () => {},
      },
      client: { sendGroupMsg: async () => {} },
      summarizer: { summarize: async () => 'x' },
      filterMessages: passThrough,
      minMessages: 1,
      manualCmds: ['总结'],
      maxWindowHours: 72,
      isReady: () => true,
    });
    const reg = new PluginRegistry();
    reg.register(plugin);
    reg.dispatch({ groupId: 4, text: '总结' });
    await tick();
    assert.deepEqual(loaded, [since]);
  });
});

describe('report 日报补跑（2026-10）', () => {
  function mkCatchUp({ reportHour = 0, reportMinute = 0, interval = 10, stateFile, ready = true } = {}) {
    let summaries = 0;
    const plugin = createReportPlugin({
      store: {
        loadFromDisk: () => {},
        collectRange: () => [{ time: Math.floor(Date.now() / 1000), text: '摸鱼' }],
      },
      client: {
        selfId: 1,
        getGroupInfo: async () => ({ group_name: '测试群' }),
        sendPrivateForward: async () => {},
        sendPrivateMsg: async () => {},
      },
      summarizer: { summarize: async () => { summaries++; return '日报内容'; } },
      scheduler: { start: () => {}, stop: () => {} },
      filterMessages: passThrough,
      trackedGroups: () => [1],
      getAllGroupIds: async () => [1],
      reportUserId: 9,
      reportMinMessages: 1,
      reportHour,
      reportMinute,
      stateFile,
      catchUpIntervalMs: interval,
      isReady: () => ready,
    });
    return { plugin, get summaries() { return summaries; } };
  }

  const todayLocal = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('已过触发时刻且今日未发：自动补跑一次并记录日期；同日不重复', async () => {
    const stateFile = path.join(makeTmp(), 'report.json');
    const h = mkCatchUp({ stateFile });
    h.plugin.hooks.start();
    await tick(60);
    h.plugin.hooks.stop();
    assert.equal(h.summaries, 1);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastReportDate, todayLocal());
    await tick(40);
    assert.equal(h.summaries, 1); // 已记录今日，不再补跑
  });

  it('未到触发时刻 / WS 未就绪：不补跑、不写状态', async () => {
    const dir = makeTmp();
    const state1 = path.join(dir, 'report-a.json');
    const h1 = mkCatchUp({ reportHour: 23, reportMinute: 59, stateFile: state1 });
    h1.plugin.hooks.start();
    await tick(50);
    h1.plugin.hooks.stop();
    assert.equal(h1.summaries, 0);
    assert.equal(fs.existsSync(state1), false);

    const state2 = path.join(dir, 'report-b.json');
    const h2 = mkCatchUp({ stateFile: state2, ready: false });
    h2.plugin.hooks.start();
    await tick(50);
    h2.plugin.hooks.stop();
    assert.equal(h2.summaries, 0);
    assert.equal(fs.existsSync(state2), false);
  });
});

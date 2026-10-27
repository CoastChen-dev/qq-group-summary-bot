/*
 * MAA 游戏控制指令插件（2026-10 新增）：在群里用 `maa …` 指挥明日方舟自动化。
 *
 * 消息面：priority 380（PRIORITY.maa）= 统计 400 之后、平台状态 350 之前；整串锚定
 * /^maa(?:\s+…)?$/i，命中即消费消息。默认**只有主人**（config.owner.userId）可下指令——
 * 刷图/公招会消耗理智与招募许可，不能让全群随便点。
 *
 * 指令：
 *   maa 帮助 | 状态 | 停止
 *   maa 唤醒                       → StartUp
 *   maa 刷图 <关卡> [次数]         → Fight {stage, times}
 *   maa 公招 [次数]                → Recruit {select:[4], confirm:[3,4], times}
 *   maa 基建                       → Infrast（默认设施 + 无人机加速贸易）
 *
 * 异步语义：提交后立刻回执「已开始」，后台每 pollIntervalMs 查一次任务，结束（done/error/
 * stopped）后把结果与掉落汇总发回群里；同一时刻只允许一个任务（worker 侧单实例，409 兜底）。
 *
 * 依赖：MaaBridge（core/platform/maa.js，经 deps 注入）、NapCatClient（发消息）、logger。
 * 实例化点：core/runtime.js createApp（config.maa.enabled 时构造并注册）。
 */
import { PRIORITY } from '../core/registry.js';
import { log, err } from '../core/platform/logger.js';

const HELP = [
  '【MAA 指令】（仅主人）',
  'maa 状态 —— 连接与任务状态',
  'maa 唤醒 —— 启动游戏到主界面',
  'maa 日常 [关卡] [次数] —— 一条龙：唤醒→公招→基建→信用→奖励（给关卡则加刷图）',
  'maa 刷图 <关卡> [次数] —— 如「maa 刷图 CE-6 5」',
  'maa 公招 [次数] —— 自动公招（默认 4 次）',
  'maa 基建 —— 基建换班 + 无人机加速',
  'maa 领奖励 —— 领取日常奖励',
  'maa 信用 [商品…] —— 领信用并按优先级购物（默认招聘许可、龙门币）',
  'maa 截图 —— 把当前模拟器画面发到群里',
  'maa 自定义 <任务链…> —— 执行 MAA 任务链（如 maa 自定义 Award）',
  'maa 重连 —— 重新连接模拟器',
  'maa 关闭 —— 关闭游戏',
  'maa 停止 —— 停止当前任务',
].join('\n');

const DAILY_FACILITY = ['Mfg', 'Trade', 'Control', 'Power', 'Reception', 'Office', 'Dorm'];
const MALL_DEFAULT_BUY = ['招聘许可', '龙门币'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 毫秒 → 「x 分 y 秒」 */
function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * 插件描述符构造。
 * @param {Object} deps
 * @param {Object} deps.bridge - MaaBridge 实例
 * @param {Object} deps.client - NapCatClient
 * @param {string|number} deps.ownerId - 主人 QQ（空 = 禁用）
 * @param {number} [deps.pollIntervalMs=2000] - 任务轮询间隔
 * @param {number} [deps.taskTimeoutMs=5700000] - 插件侧等待上限（默认 95 分钟）
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createMaaPlugin({ bridge, client, ownerId, clientType = 'Official', pollIntervalMs = 2000, taskTimeoutMs = 95 * 60 * 1000 } = {}) {
  let watching = null; // 当前轮询 promise（仅用于防重复提示，不阻塞分发）

  const send = (ctx, text, at = false) => {
    if (!client) return;
    const p = at && ctx.userId
      ? client.sendGroupMsgAt(ctx.groupId, ctx.userId, text)
      : client.sendGroupMsg(ctx.groupId, text);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };

  /** 任务结果 → 群消息文案 */
  function summaryText(label, job) {
    const head = job.state === 'done' ? '完成' : job.state === 'stopped' ? '已停止' : '失败';
    const took = fmtElapsed((job.elapsed || 0) * 1000);
    const lines = [`【MAA】${label} ${head}（${took}）`];
    const drops = Object.entries(job.drops || {});
    if (drops.length) lines.push(`掉落：${drops.map(([k, v]) => `${k}×${v}`).join('、')}`);
    if (job.error) lines.push(`原因：${String(job.error).slice(0, 120)}`);
    return lines.join('\n');
  }

  /** 轮询任务直到结束，然后把结果发回群；临时请求失败容忍 5 次 */
  async function watchJob(jobId, ctx, label) {
    const started = Date.now();
    let fails = 0;
    while (Date.now() - started < taskTimeoutMs) {
      await sleep(pollIntervalMs);
      let job;
      try {
        job = await bridge.job(jobId);
        fails = 0;
      } catch (e) {
        if (++fails >= 5) {
          send(ctx, `【MAA】${label} 查询失败：${e.message}`);
          watching = null;
          return;
        }
        continue;
      }
      if (job.state === 'running') continue;
      send(ctx, summaryText(label, job));
      log(`[maa] ${label} 结束：${job.state}`);
      watching = null;
      return;
    }
    send(ctx, `【MAA】${label} 等待超时，可用「maa 停止」中止`);
    watching = null;
  }

  /** 提交任务链：回执 + 后台轮询（单任务走这里也一致） */
  function submitMany(ctx, tasks, label) {
    bridge.submitMany(tasks).then((r) => {
      send(ctx, `【MAA】${label} 已开始，完成后回报`, true);
      watching = watchJob(r.job_id, ctx, label);
    }).catch((e) => {
      const msg = e && e.status === 409 ? '已有任务在跑，先「maa 停止」' : (e.message || '启动失败');
      send(ctx, `【MAA】${label} 未启动：${msg}`, true);
    });
    return true;
  }

  /** 提交单个任务 */
  function submit(ctx, type, params, label) {
    return submitMany(ctx, [{ type, params }], label);
  }

  /** 解析并执行一条 maa 指令；返回 true/string/null */
  function handleMessage(ctx) {
    const t = String(ctx.text || '').trim();
    const m = t.match(/^maa(?:\s+([\s\S]*))?$/i);
    if (!m) return null;
    if (!bridge) return 'MAA 未启用（config.maa.enabled）';
    if (!ownerId) return '未配置主人（owner.userId），maa 指令已禁用';
    if (String(ctx.userId || '') !== String(ownerId)) return '只有主人能控制游戏喵';
    if (watching) return '已有 MAA 任务在跑，先「maa 停止」';

    const sub = String(m[1] || '帮助').trim();
    const [head, ...rest] = sub.split(/\s+/);

    if (/^(帮助|help|指令)$/i.test(head)) return HELP;
    if (/^(状态|status)$/i.test(head)) {
      bridge.status().then((s) => {
        const job = s.job && s.job.state === 'running'
          ? `${(s.job.tasks || []).map((t) => t.type).join(' → ') || s.job.type} 进行中（${fmtElapsed((s.job.elapsed || 0) * 1000)}）`
          : '空闲';
        send(ctx, [
          '【MAA 状态】',
          `MaaCore：${s.version || '未知'}`,
          `设备：${s.connected ? '已连接' : '未连接'}`,
          `任务：${job}`,
          s.last_error ? `备注：${s.last_error}` : '',
        ].filter(Boolean).join('\n'), true);
      }).catch((e) => send(ctx, `【MAA】状态查询失败：${e.message}`, true));
      return true;
    }
    if (/^(截图|截屏|screenshot|screen)$/i.test(head)) {
      bridge.screenshot().then((png) => {
        if (!client || typeof client.sendGroupImage !== 'function') {
          send(ctx, '【MAA】当前客户端不支持发图', true);
          return;
        }
        const caption = `【MAA 截图】${new Date().toLocaleString('zh-CN', { hour12: false })}`;
        Promise.resolve(client.sendGroupImage(ctx.groupId, png, caption))
          .catch((e) => send(ctx, `【MAA】截图发送失败：${e.message}`, true));
        log(`[maa] 截图 ${Math.round(png.length / 1024)}KB`);
      }).catch((e) => send(ctx, `【MAA】截图失败：${e.message}`, true));
      return true;
    }
    if (/^(停止|stop)$/i.test(head)) {
      bridge.stop().then(() => {
        send(ctx, '【MAA】已发送停止指令', true);
        watching = null;
      }).catch((e) => send(ctx, `【MAA】停止失败：${e.message}`, true));
      return true;
    }
    if (/^(唤醒|启动|startup)$/i.test(head)) {
      return submit(ctx, 'StartUp', { client_type: clientType }, '启动游戏');
    }
    if (/^(日常|daily)$/i.test(head)) {
      // 一条龙：唤醒 → 公招 → 基建 → 信用 → 奖励（给了关卡再追加刷图，放在唤醒之后）
      const stage = rest[0];
      const times = Math.min(Math.max(parseInt(rest[1] || '5', 10) || 5, 1), 99);
      const tasks = [{ type: 'StartUp', params: { client_type: clientType } }];
      if (stage) tasks.push({ type: 'Fight', params: { stage, times, client_type: clientType } });
      tasks.push(
        { type: 'Recruit', params: { select: [4], confirm: [3, 4], times: 4 } },
        { type: 'Infrast', params: { facility: DAILY_FACILITY, drones: 'Money' } },
        { type: 'Mall', params: { shopping: true, buy_first: MALL_DEFAULT_BUY, blacklist: ['家具', '碳'] } },
        { type: 'Award', params: {} },
      );
      return submitMany(ctx, tasks, stage ? `日常（含 ${stage} ×${times}）` : '日常');
    }
    if (/^(刷图|刷理智|fight)$/i.test(head)) {
      const stage = rest[0];
      if (!stage) return '用法：maa 刷图 <关卡> [次数]，例如「maa 刷图 CE-6 5」';
      const times = Math.min(Math.max(parseInt(rest[1] || '1', 10) || 1, 1), 99);
      return submit(ctx, 'Fight', { stage, times, client_type: clientType }, `刷图 ${stage} ×${times}`);
    }
    if (/^(公招|招募|recruit)$/i.test(head)) {
      const times = Math.min(Math.max(parseInt(rest[0] || '4', 10) || 4, 1), 99);
      return submit(ctx, 'Recruit', { select: [4], confirm: [3, 4], times }, `公招 ×${times}`);
    }
    if (/^(基建|infrast)$/i.test(head)) {
      return submit(ctx, 'Infrast', {
        facility: DAILY_FACILITY,
        drones: 'Money',
      }, '基建换班');
    }
    if (/^(领奖励|奖励|award)$/i.test(head)) {
      return submit(ctx, 'Award', {}, '领取日常奖励');
    }
    if (/^(信用|购物|mall)$/i.test(head)) {
      const buylist = rest.join(' ').split(/[、,，\s]+/).filter(Boolean);
      return submit(ctx, 'Mall', {
        shopping: true,
        buy_first: buylist.length ? buylist : MALL_DEFAULT_BUY,
        blacklist: ['家具', '碳'],
      }, '领取信用');
    }
    if (/^(自定义|custom)$/i.test(head)) {
      const names = rest.join(' ').split(/[、,，\s]+/).filter(Boolean);
      if (!names.length) return '用法：maa 自定义 <任务链名> [更多…]，例如「maa 自定义 Award」';
      return submit(ctx, 'Custom', { task_names: names }, `自定义 ${names.join('+')}`);
    }
    if (/^(重连|connect)$/i.test(head)) {
      bridge.connect().then((r) => {
        send(ctx, r.connected ? '【MAA】已重新连接设备' : `【MAA】重连失败：${r.error || '未知原因'}`, true);
      }).catch((e) => send(ctx, `【MAA】重连失败：${e.message}`, true));
      return true;
    }
    if (/^(关闭游戏|关闭|closedown)$/i.test(head)) {
      return submit(ctx, 'CloseDown', {}, '关闭游戏');
    }
    return `没听懂的指令：${sub}\n\n${HELP}`;
  }

  return {
    name: 'maa',
    priority: PRIORITY.maa,
    handleMessage,
    hooks: {
      async start() {
        try {
          await bridge.start();
          log(`[maa] 桥已就绪（${bridge.baseUrl}）`);
        } catch (e) {
          err('[maa] 桥启动失败:', e.message);
        }
      },
      stop() {
        try { bridge.close(); } catch (e) { err('[maa] 桥关闭失败:', e.message); }
      },
    },
  };
}

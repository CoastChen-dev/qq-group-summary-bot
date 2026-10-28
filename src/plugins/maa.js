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
  'maa 抽卡十连 / maa 抽卡单抽 —— 真抽卡（需 allowGacha；会先要二次确认）',
  'maa 确认 / maa 取消 —— 确认或放弃待执行的抽卡',
  'maa 肉鸽 <主题> [模式] [次数] —— 主题：傀影/水月/萨米/萨卡兹/界园/黑洞（默认模式 0 刷分）',
  'maa 生息 [0|1|RA1|RA15|RA4] —— 生息演算：0/1=沙洲遗闻刷点，RA*=重启锚点',
  'maa 自定义 <任务链…> —— 执行 MAA 任务链（如 maa 自定义 Award）',
  'maa 重连 —— 重新连接模拟器',
  'maa 关闭 —— 关闭游戏',
  'maa 停止 —— 停止当前任务',
].join('\n');

const DAILY_FACILITY = ['Mfg', 'Trade', 'Control', 'Power', 'Reception', 'Office', 'Dorm'];
const MALL_DEFAULT_BUY = ['招聘许可', '龙门币'];
// 真抽卡：MAA 没有公开的 Gacha 任务类型，这里走 resources/tasks/tasks.json 里的任务链（Custom）。
// 会消耗真实货币（合成玉/源石/寻访凭证），因此默认关闭 + 二次确认。
const GACHA = {
  十连: { chain: 'GachaTenTimes', cost: '6000 合成玉 / 10 张寻访凭证（以游戏内为准）' },
  单抽: { chain: 'GachaOnce', cost: '600 合成玉 / 1 张寻访凭证（以游戏内为准）' },
};

// 肉鸽主题：中文别名 → MAA theme 枚举（本地 resource/tasks/Roguelike 下同名文件）
const RL_THEMES = {
  傀影: 'Phantom', phantom: 'Phantom',
  水月: 'Mizuki', mizuki: 'Mizuki',
  萨米: 'Sami', sami: 'Sami',
  萨卡兹: 'Sarkaz', sarkaz: 'Sarkaz',
  界园: 'JieGarden', jiegarden: 'JieGarden',
  黑洞: 'BlackFlow', 黑流: 'BlackFlow', blackflow: 'BlackFlow',
};

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
 * @param {string} [deps.clientType='Official'] - 客户端类型（StartUp/Fight 用）
 * @param {number} [deps.pollIntervalMs=2000] - 任务轮询间隔
 * @param {number} [deps.taskTimeoutMs=5700000] - 插件侧等待上限（默认 95 分钟）
 * @param {boolean} [deps.allowGacha=false] - 是否允许真抽卡（默认关，需显式开启）
 * @param {number} [deps.gachaConfirmMs=60000] - 抽卡确认有效期
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createMaaPlugin({
  bridge, client, ownerId, clientType = 'Official', pollIntervalMs = 2000,
  taskTimeoutMs = 95 * 60 * 1000, allowGacha = false, gachaConfirmMs = 60000,
} = {}) {
  let watching = null; // 当前轮询 promise（仅用于防重复提示，不阻塞分发）
  const pendingGacha = new Map(); // groupId → { chain, label, cost, expiresAt }

  const send = (ctx, text, at = false) => {
    if (!client) return;
    const p = at && ctx.userId && !ctx.noAt
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
  async function watchJob(jobId, ctx, label, timeoutMs = taskTimeoutMs) {
    const started = Date.now();
    let fails = 0;
    while (Date.now() - started < timeoutMs) {
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
      // 真抽卡结束后补一张结果截图（gacha 没有掉落回调，结果只能看画面）
      if (job.state === 'done' && label.startsWith('真抽卡')) {
        try {
          const png = await bridge.screenshot();
          if (client && typeof client.sendGroupImage === 'function') {
            await client.sendGroupImage(ctx.groupId, png, '【MAA 抽卡结果】');
          }
        } catch (e) {
          log(`[maa] 抽卡结果截图失败: ${e.message}`);
        }
      }
      log(`[maa] ${label} 结束：${job.state}`);
      watching = null;
      return;
    }
    send(ctx, `【MAA】${label} 等待超时，可用「maa 停止」中止`);
    watching = null;
  }

  /** 提交任务链：回执 + 后台轮询（单任务走这里也一致）；opts.timeoutMinutes 会同时放宽 worker 与轮询上限 */
  function submitMany(ctx, tasks, label, opts = {}) {
    bridge.submitMany(tasks, opts.timeoutMinutes).then((r) => {
      send(ctx, `【MAA】${label} 已开始，完成后回报`, true);
      const watchMs = opts.timeoutMinutes ? (opts.timeoutMinutes + 5) * 60000 : taskTimeoutMs;
      watching = watchJob(r.job_id, ctx, label, watchMs);
    }).catch((e) => {
      const msg = e && e.status === 409 ? '已有任务在跑，先「maa 停止」' : (e.message || '启动失败');
      send(ctx, `【MAA】${label} 未启动：${msg}`, true);
    });
    return true;
  }

  /** 提交单个任务 */
  function submit(ctx, type, params, label, opts = {}) {
    return submitMany(ctx, [{ type, params }], label, opts);
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
    if (/^抽卡(十连|单抽)$/.test(head)) {
      if (!allowGacha) return '真抽卡未启用（把 config.maa.allowGacha 设为 true 才可用）';
      const kind = head.replace('抽卡', '');
      const g = GACHA[kind];
      pendingGacha.set(String(ctx.groupId), {
        chain: g.chain, label: kind, cost: g.cost, expiresAt: Date.now() + gachaConfirmMs,
      });
      return [
        `【MAA】确认要执行「真抽卡·${kind}」吗？`,
        `消耗：${g.cost}`,
        `${Math.round(gachaConfirmMs / 1000)} 秒内回复「maa 确认」执行，「maa 取消」放弃。`,
      ].join('\n');
    }
    if (/^(确认|确认抽卡|confirm)$/i.test(head)) {
      const key = String(ctx.groupId);
      const p = pendingGacha.get(key);
      if (!p) return '没有待确认的抽卡（先发「maa 抽卡十连」或「maa 抽卡单抽」）';
      pendingGacha.delete(key);
      if (Date.now() > p.expiresAt) return '抽卡确认已过期，请重新发起';
      // 先 StartUp 确保在主界面，再执行抽卡任务链（从任何界面发起都稳）
      return submitMany(ctx, [
        { type: 'StartUp', params: { client_type: clientType } },
        { type: 'Custom', params: { task_names: [p.chain] } },
      ], `真抽卡·${p.label}`);
    }
    if (/^(取消|cancel)$/i.test(head)) {
      return pendingGacha.delete(String(ctx.groupId)) ? '已取消待确认的抽卡' : '没有待确认的抽卡';
    }
    if (/^(肉鸽|roguelike)$/i.test(head)) {
      const rawTheme = rest[0];
      if (!rawTheme) {
        return '用法：maa 肉鸽 <主题> [模式] [次数]\n主题：傀影 / 水月 / 萨米 / 萨卡兹 / 界园 / 黑洞\n'
          + '模式：0=刷分（默认），1=刷源石锭，4=凹开局，5=刷坍缩（仅萨米），6/7=月度/深入，'
          + '10001=萨卡兹速通，20001=界园刷常乐，30001/30003=黑流\n例：maa 肉鸽 萨米 0 1';
      }
      const theme = RL_THEMES[rawTheme] || RL_THEMES[rawTheme.toLowerCase()];
      if (!theme) return `未知主题「${rawTheme}」，可选：傀影 / 水月 / 萨米 / 萨卡兹 / 界园 / 黑洞`;
      // mode 2 已在 MAA 中移除、3 未开放，传入会被 Core 拒绝（append_task 返回 0）；默认 0 刷分
      const mode = rest[1] !== undefined ? (parseInt(rest[1], 10) || 0) : 0;
      const times = Math.min(Math.max(parseInt(rest[2] || '1', 10) || 1, 1), 999);
      return submit(ctx, 'Roguelike', { theme, mode, starts_count: times },
        `肉鸽 ${rawTheme}（模式 ${mode} ×${times}）`, { timeoutMinutes: 240 });
    }
    if (/^(生息|生息演算|reclamation)$/i.test(head)) {
      const arg = String(rest[0] || '').toUpperCase().replace(/\s/g, '');
      let params;
      let label;
      if (!arg || arg === '0' || arg === '1') {
        params = { theme: 'Tales', mode: arg === '1' ? 1 : 0 };
        label = `生息演算·沙洲遗闻（模式 ${params.mode}）`;
      } else if (/^RA-?1$/.test(arg)) {
        params = { theme: 'RelaunchAnchor', mode: 16 };
        label = '生息演算·重启锚点 RA-1';
      } else if (/^RA-?15$/.test(arg)) {
        params = { theme: 'RelaunchAnchor', mode: 32 };
        label = '生息演算·重启锚点 RA-15';
      } else if (/^RA-?4$/.test(arg)) {
        params = { theme: 'RelaunchAnchor', mode: 48 };
        label = '生息演算·重启锚点 RA-4';
      } else {
        return '用法：maa 生息 [0|1|RA1|RA15|RA4]\n0=沙洲遗闻无存档刷点（默认），1=有存档造物，RA*=重启锚点';
      }
      return submit(ctx, 'Reclamation', params, label, { timeoutMinutes: 240 });
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

/*
 * 每日日报后台插件（P3b 由 runtime.js 迁入：原 dailyReport 编排正文 + getGroupName 群名查询，
 * 门限与文案逐字保持）。
 *
 * 无消息面：仅 hooks 插件（不参与 dispatch——本插件 handleMessage 恒 null；priority 0 使
 * startAll 时排在最后，仅 hooks 的 start/stop 次序有意义，见 refactor-proposal「report 仅 hooks」）。
 * hooks.start → scheduler.start(run)：注册每日 9:00 定时回调（调度循环由 core/platform/scheduler.js 自驱，
 * 每天触发一次后自动排下一天）；hooks.stop → scheduler.stop()（停服收尾，旧实现由 runtime 直调，
 * 插件化后调度器归本插件所有，生命周期随 registry.stopAll 逆序停）。
 *
 * 编排口径（§6.2，逐字迁自 runtime）：守卫 isReady() 与 reportUserId（未配置则跳过）；
 * 口径 = 昨日本地自然日 [昨日00:00, 今日00:00) —— 每群 loadFromDisk(gid, yesterdayStart,
 * todayStart) 载入该日期段再 collectRange + 敏感过滤，消息数 ≥ reportMinMessages(100) 才算
 * 活跃群 → 逐群 summarize(...,'daily')（单群失败继续），全部失败则不发送；成功则以
 * 「合并转发」私聊发给 reportUserId（标题节点 + 每群一个节点；转发失败回退整条文本）。
 * 全程不写 lastSummaryAt/lastSeen 状态。
 *
 * 启动补跑（2026-10）：调度器只在进程内触发，重启/断线错过 9:00 当天就没有日报（实测 10-27
 * 机器人 09:44 才启动，当天未发）。hooks.start 后每 catchUpIntervalMs 检查一次：已过今日触发
 * 时刻、未记录今日已发、WS 就绪 → 补跑一次（同进程同一天最多一次，避免 LLM 失败后反复重试）；
 * 发送成功或「无活跃群」把日期写入 data/state/report.json。
 *
 * 依赖：logger；服务/配置经 createReportPlugin(deps) 注入（scheduler/就绪标志属 runtime 资产，
 * 经 deps 移交；getAllGroupIds 与 backfillHistory 共用、现居 core/routing.js 工厂并经 deps 注入）；
 * 实例化点：core/runtime.js createApp 装配期。
 * 读写数据：读消息存储（loadFromDisk/collectRange）；经 summarizer 调 LLM 概括；私聊经 client。
 */
import fs from 'node:fs';
import { log, err } from '../core/platform/logger.js';
import { splitMessage } from '../core/platform/text.js';
import { writeFileAtomic } from '../core/platform/atomic.js';
import { localDate } from '../core/platform/store.js';

/**
 * 每日日报插件描述符构造：{name:'report', priority: 0, handleMessage, hooks:{start,stop}}。
 * 仅 hooks 插件：priority 0 不占任何分发带（消息面恒 null）；hooks.start 起每日调度。
 * @param {Object} deps - runtime 装配期注入
 * @param {Object} deps.store - MessageStore 实例（loadFromDisk/collectRange）
 * @param {Object} deps.client - NapCatClient 实例（getGroupInfo 群名 / sendPrivateForward 合并转发 / sendPrivateMsg 回退）
 * @param {Object} deps.summarizer - Summarizer 实例（LLM 概括，mode 'daily'）
 * @param {Object} deps.scheduler - Scheduler 实例（每日循环调度，触发时刻由构造传参决定——runtime 按
 *   report.hour/minute 装配，缺省 9:00；start 在 hooks.start 注册）
 * @param {Function} deps.filterMessages - (recs) => {kept, filtered} 敏感过滤包装（同 summary 插件）
 * @param {Function} deps.trackedGroups - () => Array，config.groups 访问器
 * @param {Function} deps.getAllGroupIds - () => Promise<Array>，活跃群集合（与 routing backfillHistory 共用）
 * @param {number} deps.reportUserId - 日报私聊收件人（config.report.userId；0/缺省 = 不启用）
 * @param {number} deps.reportMinMessages - 活跃群消息门槛（config.report.minMessages ?? 100）
 * @param {Function} deps.isReady - () => boolean，WS 就绪锚点
 * @param {number} [deps.reportHour=9] - 日报触发小时（补跑检查用）
 * @param {number} [deps.reportMinute=0] - 日报触发分钟
 * @param {string} [deps.stateFile] - 日报状态文件（如 data/state/report.json）；空 = 不落盘（测试）
 * @param {number} [deps.catchUpIntervalMs=300000] - 启动补跑检查间隔（缺省 5 分钟）
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createReportPlugin(deps) {
  const { store, client, summarizer, scheduler, filterMessages, trackedGroups, getAllGroupIds, episodic } = deps;
  const reportUserId = deps.reportUserId || 0;
  const reportMinMessages = deps.reportMinMessages ?? 100;
  const isReady = deps.isReady;
  const reportHour = Number(deps.reportHour ?? 9);
  const reportMinute = Number(deps.reportMinute ?? 0);
  const stateFile = deps.stateFile || '';
  // 下限 10ms 只服务测试注入；生产缺省 5 分钟
  const catchUpIntervalMs = Math.max(10, Number(deps.catchUpIntervalMs ?? 5 * 60 * 1000));
  let catchUpTimer = null;
  let firstCheckTimer = null;
  let lastCatchUpDate = '';
  let reportRunning = false;

  // 读今日已发日期（缺失/损坏返回空串——安全侧：下次启动会重新补跑）
  function readLastReportDate() {
    if (!stateFile) return '';
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return typeof data?.lastReportDate === 'string' ? data.lastReportDate : '';
    } catch {
      return '';
    }
  }

  // 标记今日日报已完成（发送成功或明确「无活跃群」；生成失败不标记，留给下次启动重试）
  function markReportedToday() {
    if (!stateFile) return;
    try {
      writeFileAtomic(stateFile, JSON.stringify({ lastReportDate: localDate(Date.now()) }));
    } catch (e) {
      log(`[report] 日报状态写入失败: ${e.message}`);
    }
  }

  /**
   * 日报标题用群名查询：get_group_info 失败或无群名时回退群号字符串，不向外抛。
   * @param {string|number} groupId - 群号
   * @returns {Promise<string>} 群名或 String(groupId)
   */
  async function getGroupName(groupId) {
    try {
      const info = await client.getGroupInfo(groupId);
      return info?.group_name || String(groupId);
    } catch {
      return String(groupId);
    }
  }

  /**
   * 每日日报编排正文（§6.2；由 dailyReport() 互斥包装后供 scheduler 与启动补跑调用）：
   * 守卫 isReady 与 reportUserId（未配置则跳过）；口径 = 昨日本地自然日 [昨日00:00, 今日00:00)
   * —— 每群 loadFromDisk(gid, yesterdayStart, todayStart) 载入该日期段再 collectRange + 敏感过滤，
   * 消息数 ≥ reportMinMessages(100) 才算活跃群 → 逐群 summarize(...,'daily')（单群失败继续），
   * 全部失败则不发送；成功则私聊发给 report.userId。全程不写 lastSummaryAt/lastSeen 状态。
   *
   * @returns {Promise<void>}
   * 副作用：私聊发送日报消息
   */
  async function runDailyReport() {
    if (!isReady()) return;
    if (!reportUserId) {
      log('[report] 未配置 report.userId，跳过日报');
      return;
    }

    const now = new Date();
    // 昨日由 Date 归一（跨月/跨年自动进位）：不能用 getDate()-1 拼字符串——每月 1 号会拼出「YYYY-MM-00」
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const yesterdayStart = yesterday.getTime() / 1000;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const yesterdayLabel = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    const groups = trackedGroups().length > 0 ? trackedGroups() : await getAllGroupIds();
    const activeGroups = [];
    const quietGroups = []; // 不够日报门槛、但仍值得记一笔的群（≥5 条）

    for (const gid of groups) {
      store.loadFromDisk(gid, yesterdayStart, todayStart);
      const recs = store.collectRange(gid, yesterdayStart, todayStart);
      const { kept, filtered } = filterMessages(recs);
      if (filtered.length > 0) {
        log(`[report] 群 ${gid} 已过滤 ${filtered.length} 条敏感/隐私消息`);
      }
      if (kept.length >= reportMinMessages) activeGroups.push({ gid, recs: kept });
      else if (kept.length >= 5) quietGroups.push({ gid, recs: kept });
    }

    // 情节记忆：冷清群也记（≥5 条），免得「那天什么都没发生」；失败不影响日报
    for (const { gid, recs } of quietGroups) {
      if (!episodic || typeof summarizer.extractMemories !== 'function') break;
      try {
        const items = await summarizer.extractMemories(gid, recs);
        if (items.length) episodic.save(gid, yesterdayLabel, items);
      } catch (e) {
        log(`[report] 群 ${gid} 情节记忆提炼失败: ${e.message}`);
      }
    }

    if (activeGroups.length === 0) {
      log(`[report] 昨日(${yesterdayLabel})无活跃群（≥${reportMinMessages}条），跳过`);
      markReportedToday(); // 今日已处理（无活跃群也算完成，避免补跑每 5 分钟重试）
      return;
    }

    log(`[report] 昨日(${yesterdayLabel})活跃群 ${activeGroups.length} 个，正在生成日报...`);
    const parts = []; // {name, text}
    for (const { gid, recs } of activeGroups) {
      try {
        const name = await getGroupName(gid);
        const summary = await summarizer.summarize(gid, recs, yesterdayLabel, 'daily');
        parts.push({ name, text: `${recs.length} 条消息\n${summary}` });
        log(`[report] 群 ${gid}(${name}) 日报已生成`);
        // 情节记忆：把昨天的小事存下来，供以后对话作背景（失败不影响日报）
        if (episodic && typeof summarizer.extractMemories === 'function') {
          try {
            const items = await summarizer.extractMemories(gid, recs);
            if (items.length) episodic.save(gid, yesterdayLabel, items);
          } catch (e) {
            log(`[report] 群 ${gid} 情节记忆提炼失败: ${e.message}`);
          }
        }
      } catch (e) {
        err(`[report] 群 ${gid} 日报失败:`, e.message);
      }
    }

    if (parts.length === 0) {
      log('[report] 所有群日报生成失败，跳过发送');
      return;
    }

    // 合并转发（2026-10）：标题节点 + 每群一个节点（「每群一条消息」）；失败回退整条私聊文本
    const header = `【昨日群聊日报 ${yesterdayLabel}】共 ${parts.length} 个活跃群`;
    const uin = client.selfId || 0;
    const nodes = [
      { type: 'node', data: { uin, name: 'Mon3tr 日报', content: header } },
      ...parts.map((p) => ({ type: 'node', data: { uin, name: p.name, content: p.text } })),
    ];
    try {
      await client.sendPrivateForward(reportUserId, nodes);
      log(`[report] 日报已合并转发给 ${reportUserId}（${nodes.length} 个节点）`);
    } catch (e) {
      err('[report] 合并转发失败，回退整条私聊:', e.message);
      const msg = `${header}\n\n${parts.map((p) => `【${p.name}】${p.text}`).join('\n\n---\n\n')}`;
      // 私聊同样有单条字节上限：兜底文本按 3500B 切条依次发送（2026-10）
      for (const part of splitMessage(msg)) {
        await client.sendPrivateMsg(reportUserId, part);
      }
    }
    markReportedToday(); // 日报已送达：记录今日，补跑检查不再重复
  }

  /**
   * 日报入口（调度器每日触发与启动补跑共用）：互斥执行，防止 9:00 与补跑同时发两份。
   * @returns {Promise<void>}
   */
  async function dailyReport() {
    if (reportRunning) {
      log('[report] 日报已在生成中，跳过本次触发');
      return;
    }
    reportRunning = true;
    try {
      await runDailyReport();
    } finally {
      reportRunning = false;
    }
  }

  /**
   * 启动补跑检查（2026-10）：日报只在进程内 9:00 触发，重启/断线错过就整天没有。
   * 已过今日触发时刻、未记录今日已发、WS 就绪 → 补跑一次；同进程同一天最多一次，
   * 避免 LLM 失败后每 5 分钟重试烧 token。
   * @returns {void}
   */
  function maybeCatchUp() {
    if (!reportUserId || !isReady()) return;
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < reportHour * 60 + reportMinute) return; // 还没到今日触发时刻
    const today = localDate(now.getTime());
    if (readLastReportDate() === today) return; // 今日已发/已处理过
    if (lastCatchUpDate === today) return; // 本进程今天已尝试过（失败等下次启动）
    lastCatchUpDate = today;
    log(`[report] 今日日报尚未发送（错过 ${reportHour}:${String(reportMinute).padStart(2, '0')} 或启动较晚），补跑一次`);
    dailyReport().catch((e) => err('[report] 日报补跑失败:', e.message));
  }

  return {
    name: 'report',
    // 仅 hooks 插件：0 不占分发带（handleMessage 恒 null，永不认领消息）；start 次序排在最后无碍
    priority: 0,
    handleMessage() {
      return null;
    },
    hooks: {
      /** 注册每日 9:00 日报调度；另起启动补跑检查（首次最多 60s 后、此后每 catchUpIntervalMs） */
      start() {
        scheduler.start(dailyReport);
        firstCheckTimer = setTimeout(maybeCatchUp, Math.min(catchUpIntervalMs, 60 * 1000));
        firstCheckTimer.unref?.(); // 不拖住进程退出（测试/停服）
        catchUpTimer = setInterval(maybeCatchUp, catchUpIntervalMs);
        catchUpTimer.unref?.();
      },
      /** 停服：停掉每日调度器与补跑检查定时器 */
      stop() {
        scheduler.stop();
        if (firstCheckTimer) { clearTimeout(firstCheckTimer); firstCheckTimer = null; }
        if (catchUpTimer) { clearInterval(catchUpTimer); catchUpTimer = null; }
      },
    },
  };
}

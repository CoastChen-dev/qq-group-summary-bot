import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NapCatClient } from './napcat.js';
import { MessageStore, fmtFull } from './store.js';
import { Summarizer } from './summarizer.js';
import { ChatBot } from './chat.js';
import { Scheduler } from './scheduler.js';
import { filterMessages as filterMessagesRaw } from './filter.js';
import { tryCommand } from './commands.js';
import { Analytics } from './analytics.js';
import { DataRefresher } from './refresher.js';
import { log, err } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const configPath = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.join(root, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const llm = config.llm || {};
if (!llm.apiKey) llm.apiKey = process.env.LLM_API_KEY || '';
if (!llm.apiKey) {
  err('未配置 LLM API Key：请在 config.json 的 llm.apiKey 或环境变量 LLM_API_KEY 中设置。');
  process.exit(1);
}

const dataDir = path.resolve(root, config.dataDir || './data');
const store = new MessageStore(dataDir);
const client = new NapCatClient(config.napcat.wsUrl, {
  selfId: config.napcat.selfId || 0,
  accessToken: config.napcat.accessToken || '',
});
const summarizer = new Summarizer(llm);
const chatBot = new ChatBot(llm);
const scheduler = new Scheduler(config.schedule || {});
const analytics = new Analytics(path.join(dataDir, 'messages.db'), path.join(dataDir, 'messages'));
const refresher = new DataRefresher(path.join(dataDir, 'ark'), config.dataRefresh || {});

// 定期更新本地数据库（ArknightsGameData），带新增内容播报
async function refreshData(notifyGroupId = null) {
  log('[refresh] 开始更新本地数据...');

  // 快照旧数据（用于新增播报对比）
  chatBot.arkdb.load();
  const oldHighOps = new Map();
  for (const c of chatBot.arkdb.characters.values()) {
    if ((c.rarity === 'TIER_6' || c.rarity === 'TIER_5') && c.name && chatBot.arkdb._isOperator(c)) {
      oldHighOps.set(c.id, c.name);
    }
  }
  const oldPoolIds = new Set(chatBot.arkdb.gachaPools.map((p) => p.gachaPoolId));

  const { updated, unchanged, failed } = await refresher.refresh();

  let announce = '';
  if (updated.length > 0) {
    chatBot.arkdb.reload();
    log('[refresh] 内存数据已重新加载');

    // 对比新增内容
    const new6 = [];
    const new5 = [];
    for (const c of chatBot.arkdb.characters.values()) {
      if (!c.name || !chatBot.arkdb._isOperator(c)) continue;
      if (!oldHighOps.has(c.id)) {
        if (c.rarity === 'TIER_6') new6.push(c.name);
        else if (c.rarity === 'TIER_5') new5.push(c.name);
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const newPools = [];
    for (const p of chatBot.arkdb.gachaPools) {
      if (!oldPoolIds.has(p.gachaPoolId) && (!p.openTime || p.openTime <= now) && (!p.endTime || p.endTime >= now)) {
        newPools.push(p.gachaPoolName);
      }
    }
    const parts = [];
    if (new6.length) parts.push(`新增 6★ 干员：${new6.join('、')}`);
    if (new5.length) parts.push(`新增 5★ 干员：${new5.join('、')}`);
    if (newPools.length) parts.push(`新开放卡池：${[...new Set(newPools)].join('、')}`);
    if (parts.length) announce = `【数据更新播报】\n${parts.join('\n')}`;
  }

  const msg = `【数据更新】\n成功：${updated.length ? updated.join('、') : '无'}\n未变化：${unchanged.length ? unchanged.join('、') : '无'}\n${failed.length ? '失败：' + failed.join('、') : '全部成功'}`;
  if (notifyGroupId) {
    client.sendGroupMsg(notifyGroupId, msg).catch((e) => err(`[refresh] 通知发送失败:`, e.message));
    if (announce) client.sendGroupMsg(notifyGroupId, announce).catch(() => {});
  } else if (announce && config.dataRefresh?.announce !== false) {
    // 自动更新时向所有监控群播报新增内容
    const targets = trackedGroups().length ? trackedGroups() : store.trackedGroupIds();
    for (const gid of targets) {
      client.sendGroupMsg(gid, announce).catch(() => {});
    }
    log('[refresh] 已向群聊播报新增内容');
  }
  return msg;
}

{
  const dr = config.dataRefresh || {};
  if (dr.enabled !== false) {
    const firstMs = (dr.firstDelayMinutes ?? 30) * 60 * 1000;
    const intervalMs = (dr.intervalHours ?? 24) * 3600 * 1000;
    setTimeout(() => {
      refreshData().catch((e) => err('[refresh] 更新失败:', e.message));
      setInterval(() => refreshData().catch((e) => err('[refresh] 更新失败:', e.message)), intervalMs);
    }, firstMs);
    log(`[refresh] 数据定期更新已启用：首次 ${dr.firstDelayMinutes ?? 30} 分钟后，此后每 ${dr.intervalHours ?? 24} 小时`);
  }
}

const trackedGroups = () => (Array.isArray(config.groups) ? config.groups : []);
const tracksGroup = (id) => trackedGroups().length === 0 || trackedGroups().includes(id);
const minMessages = config.minMessages ?? 1;
const includeSelf = config.includeSelf === true;
const manualCmds = config.commands?.manualSummary ?? ['总结', '/总结', '#总结'];

const report = config.report || {};
const reportUserId = report.userId || 0;
const reportMinMessages = report.minMessages ?? 100;
const dailyHour = report.hour ?? 9;

const quiet = config.quiet || {};
const quietEnabled = quiet.enabled !== false;
const quietStart = quiet.start ?? 0;
const quietEnd = quiet.end ?? 8;
const filterEnabled = config.filter?.enabled !== false;
const filterMessages = (recs) => (filterEnabled ? filterMessagesRaw(recs) : { kept: recs, filtered: [] });

let selfId = config.napcat.selfId || 0;
let ready = false;
let backfillDone = false;
const summaryInFlight = new Set();

for (const gid of trackedGroups()) {
  store.loadFromDisk(gid);
}

function inQuietHours(date = new Date()) {
  if (!quietEnabled) return false;
  const h = date.getHours();
  if (quietStart < quietEnd) return h >= quietStart && h < quietEnd;
  return h >= quietStart || h < quietEnd;
}

function extractQuestion(rec, mentionedSelf) {
  if (!mentionedSelf) return rec.text.trim();
  let text = rec.text.trim();
  text = text.replace(/^@机器人\s*/, '');
  text = text.replace(/^@[^\s@]{1,30}\s*/, '');
  return text.trim();
}

async function triggerSummary(groupId, opts = {}) {
  if (!ready) return;
  if (summaryInFlight.has(groupId)) {
    log(`[group ${groupId}] 已有概括进行中，忽略重复指令`);
    return;
  }
  summaryInFlight.add(groupId);
  try {
    await doSummary(groupId, opts);
  } finally {
    summaryInFlight.delete(groupId);
  }
}

async function doSummary(groupId, opts = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  let since = store.getLastSummaryAt(groupId);
  if (!since) since = nowSec - 60 * 60;

  const recs = store.collectSince(groupId, since);
  if (recs.length === 0) {
    log(`[group ${groupId}] 该时段无消息，跳过概括`);
    return;
  }
  if (recs.length < minMessages) {
    log(`[group ${groupId}] 消息数(${recs.length})少于 minMessages(${minMessages})，跳过`);
    return;
  }

  const { kept, filtered } = filterMessages(recs);
  if (kept.length === 0) {
    log(`[group ${groupId}] 该时段消息均含敏感内容，跳过概括`);
    return;
  }
  if (filtered.length > 0) {
    log(`[group ${groupId}] 已过滤 ${filtered.length} 条敏感/隐私消息`);
  }

  const span = `从 ${fmtFull(new Date(since * 1000))} 到 ${fmtFull(new Date(recs[recs.length - 1].time * 1000))}`;
  log(`[group ${groupId}] 开始概括 ${kept.length} 条消息 (${span})`);

  const summary = await summarizer.summarize(groupId, kept, span, 'manual');
  const msg = `【群聊概括】\n${span}｜共 ${kept.length} 条消息\n\n${summary}`;

  await client.sendGroupMsg(groupId, msg);
  store.setLastSummaryAt(groupId, nowSec);
  log(`[group ${groupId}] 概括已发送`);
}

async function getGroupName(groupId) {
  try {
    const info = await client.getGroupInfo(groupId);
    return info?.group_name || String(groupId);
  } catch {
    return String(groupId);
  }
}

async function getAllGroupIds() {
  try {
    const list = await client.call('get_group_list');
    const ids = (list || []).map((g) => g.group_id).filter(Boolean);
    return ids.length > 0 ? ids : store.trackedGroupIds();
  } catch {
    return store.trackedGroupIds();
  }
}

async function backfillHistory() {
  if (!ready || backfillDone) return;
  backfillDone = true;
  const nowSec = Math.floor(Date.now() / 1000);
  const maxHours = config.backfill?.maxHours ?? 72;
  const sinceTs = Math.max(store.getLastSeenTs(), nowSec - maxHours * 3600);
  const groups = trackedGroups().length > 0 ? trackedGroups() : await getAllGroupIds();

  log(`[backfill] 启动后补偿拉取：自 ${fmtFull(new Date(sinceTs * 1000))} 起，共 ${groups.length} 个群`);
  for (const gid of groups) {
    try {
      const resp = await client.getGroupMsgHistory(gid, { messageSeq: 0, count: 1000 });
      const msgs = resp?.messages ?? resp?.data ?? [];
      let added = 0;
      let earliest = 0;
      let latest = 0;
      const seen = new Set();
      for (const m of Array.isArray(msgs) ? msgs : []) {
        if (!m) continue;
        const t = m.time ?? m.msgTime ?? 0;
        if (t < sinceTs) continue;
        if (seen.has(m.message_id)) continue;
        seen.add(m.message_id);
        const rec = store.addHistoryMessage(gid, m);
        if (rec) {
          added++;
          analytics.record(gid, rec);
        }
        if (!earliest || t < earliest) earliest = t;
        if (t > latest) latest = t;
      }
      if (added > 0) store.setLastSeenTs(latest);
      log(`[backfill] 群 ${gid} 补偿 ${added} 条离线消息${added ? `（最早 ${fmtFull(new Date(earliest * 1000))}）` : ''}`);
    } catch (e) {
      err(`[backfill] 群 ${gid} 拉取失败:`, e.message);
    }
  }
}

async function dailyReport() {
  if (!ready) return;
  if (!reportUserId) {
    log('[report] 未配置 report.userId，跳过日报');
    return;
  }

  const now = new Date();
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime() / 1000;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  const yesterdayLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate() - 1).padStart(2, '0')}`;

  const groups = trackedGroups().length > 0 ? trackedGroups() : await getAllGroupIds();
  const activeGroups = [];

  for (const gid of groups) {
    store.loadFromDisk(gid, yesterdayStart, todayStart);
    const recs = store.collectRange(gid, yesterdayStart, todayStart);
    const { kept, filtered } = filterMessages(recs);
    if (filtered.length > 0) {
      log(`[report] 群 ${gid} 已过滤 ${filtered.length} 条敏感/隐私消息`);
    }
    if (kept.length >= reportMinMessages) activeGroups.push({ gid, recs: kept });
  }

  if (activeGroups.length === 0) {
    log(`[report] 昨日(${yesterdayLabel})无活跃群（≥${reportMinMessages}条），跳过`);
    return;
  }

  log(`[report] 昨日(${yesterdayLabel})活跃群 ${activeGroups.length} 个，正在生成日报...`);
  const parts = [];
  for (const { gid, recs } of activeGroups) {
    try {
      const name = await getGroupName(gid);
      const summary = await summarizer.summarize(gid, recs, yesterdayLabel, 'daily');
      parts.push(`【${name}】${recs.length} 条消息\n${summary}`);
      log(`[report] 群 ${gid}(${name}) 日报已生成`);
    } catch (e) {
      err(`[report] 群 ${gid} 日报失败:`, e.message);
    }
  }

  if (parts.length === 0) {
    log('[report] 所有群日报生成失败，跳过发送');
    return;
  }

  const msg = `【昨日群聊日报 ${yesterdayLabel}】\n共 ${parts.length} 个活跃群\n\n${parts.join('\n\n---\n\n')}`;
  await client.sendPrivateMsg(reportUserId, msg);
  log(`[report] 日报已私聊发送给 ${reportUserId}`);
}

client.onEvent((event) => {
  if (event.post_type === 'meta_event') {
    if (event.meta_event_type === 'lifecycle' && event.sub_type === 'connect') {
      ready = true;
      (async () => {
        if (!selfId) {
          try {
            const info = await client.getLoginInfo();
            selfId = info.user_id;
            log(`[napcat] 机器人 QQ: ${selfId}`);
          } catch (e) {
            err('获取登录信息失败:', e.message);
          }
        }
        await backfillHistory();
      })();
    }
    return;
  }

  if (event.post_type !== 'message' || event.message_type !== 'group') return;
  if (selfId && event.user_id === selfId && !includeSelf) return;
  if (!tracksGroup(event.group_id)) return;

  const rec = store.addMessage(event);
  if (!rec) return;
  analytics.record(event.group_id, rec);

  const mentionedSelf = Array.isArray(event.message) &&
    event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(selfId));
  const cmd = rec.text.trim();
  const mentionedByText = cmd.includes(`@${selfId}`) || cmd.includes('@机器人') || cmd.includes('@PRTS');
  const isMentioned = mentionedSelf || mentionedByText;

  if (!isMentioned) return;

  if (inQuietHours()) {
    log(`[group ${event.group_id}] 收到 @机器人 消息但处于静默时段(${quietStart}:00-${quietEnd}:00)，忽略`);
    return;
  }

  if (manualCmds.some((c) => cmd.includes(c))) {
    log(`[group ${event.group_id}] 收到手动总结指令 (@机器人)`);
    triggerSummary(event.group_id, { manual: true }).catch((e) => err('手动总结失败:', e.message));
    return;
  }

  const question = extractQuestion(rec, true);
  if (!question) {
    log(`[group ${event.group_id}] 收到仅@机器人（无内容）的消息`);
    const senderName = event.sender?.card || event.sender?.nickname || '群友';
    client.sendGroupMsg(event.group_id, `@${senderName} 艾特PRTS干什么呀喵`).catch((e) => err(`[group ${event.group_id}] 发送提示失败:`, e.message));
    return;
  }

  // 手动刷新本地数据（联网更新 ArkgamesGameData）
  if (/^(刷新数据|更新数据|更新数据库)$/.test(question)) {
    log(`[group ${event.group_id}] 收到数据刷新指令`);
    client.sendGroupMsg(event.group_id, '正在更新本地数据库，稍候…').catch(() => {});
    refreshData(event.group_id).catch((e) => {
      err('[refresh] 手动刷新失败:', e.message);
      client.sendGroupMsg(event.group_id, `数据更新失败：${e.message}`).catch(() => {});
    });
    return;
  }

  // 确定性指令路由（词典学习/干员查询/藏品查询/统计/抽卡等，带群与用户上下文）
  const senderName = event.sender?.card || event.sender?.nickname || '群友';
  const cmdReply = tryCommand({
    lingo: chatBot.lingo,
    arkdb: chatBot.arkdb,
    analytics,
    groupId: event.group_id,
    userId: event.user_id,
    userName: senderName,
  }, question);
  if (cmdReply !== null) {
    log(`[group ${event.group_id}] 指令响应: ${question.slice(0, 30)}`);
    client.sendGroupMsg(event.group_id, cmdReply).catch((e) => err(`[group ${event.group_id}] 指令发送失败:`, e.message));
    return;
  }

  chatBot.chat(event.group_id, senderName, question, event.user_id)
    .then((reply) => {
      if (reply) return client.sendGroupMsg(event.group_id, reply);
    })
    .catch((e) => err(`[chat] 群 ${event.group_id} 发送失败:`, e.message));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号，正在关闭...');
    scheduler.stop();
    client.close();
    process.exit(0);
  });
}

client.connect();
scheduler.start(dailyReport);
log('QQ 群聊概括机器人已启动（仅 @ 触发总结；每日 9:00 发送昨日日报）');

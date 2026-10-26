/*
 * NapCat 平台状态指令插件（2026-10 新增）。
 *
 * 消息面：priority 350（PRIORITY.status）= 统计指令 400 之后、LLM 兜底 300 之前；
 * 整串锚定 /^(?:#|\/)status$/i 匹配 ctx.text（剥 @ 后问题），命中即异步查询 OneBot
 * 平台信息并真 @ 提问者，返回 true 消费消息（发送由插件自驱，与 refresh 同模式）。
 *
 * 查询面（三接口并发、allSettled 互相隔离，任一失败仅该行降级为「未知」）：
 *   get_login_info   → 账号 / 昵称
 *   get_version_info → NapCat 版本 / OneBot 协议版本
 *   get_status       → 在线 / 良好
 * 另附 WS readyState、三接口查询耗时与 Bot 进程运行时长（process.uptime）。
 *
 * 触发语义：与既有指令一致，必须 @机器人 后输入（群消息剥 @ 后的有效文本）。
 *
 * 依赖：零（仅 PRIORITY 常量）；client 经 dispatch ctx 注入（可为 null——降级为提示文案）。
 * 实例化点：src/plugins/index.js 以 descriptor 形式随 commandPlugins 数组交付 runtime 注册。
 */
import { PRIORITY } from '../core/registry.js';

const STATUS_HELP = 'NapCat 平台状态不可用：客户端未注入';

/**
 * WS readyState → 文案（1=OPEN；不 import ws，保持插件零依赖）。
 * @param {Object} client - NapCatClient（ws 为底层 WebSocket 或 null）
 * @returns {string} 连接状态文案
 */
function wsState(client) {
  const rs = client?.ws?.readyState;
  if (rs === 1) return '已连接';
  if (rs === 0) return '连接中';
  if (rs === 2) return '关闭中';
  if (rs === 3) return '已断开';
  return '未知';
}

/**
 * 秒 → 人类可读运行时长（Bot 进程维度）。
 * @param {number} sec - process.uptime() 返回值
 * @returns {string} 如「2 天 3 小时 5 分钟」
 */
function formatUptime(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return '不足 1 分钟';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时 ${m} 分钟`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

/** Promise.allSettled 结果取值：fulfilled → value，rejected → null（格式化层统一降级） */
const valueOf = (r) => (r.status === 'fulfilled' ? r.value : null);

/**
 * 插件描述符构造：{name:'status', priority: PRIORITY.status, handleMessage}。
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createStatusPlugin() {
  return {
    name: 'status',
    priority: PRIORITY.status,
    /**
     * 平台状态指令分发：命中返回 true（异步自驱发送）；未命中返回 null。
     * @param {Object} ctx - 消息上下文：{client: NapCatClient|null, groupId, userId, text}
     * @returns {true|string|null} true = 命中；string = 客户端缺失时的降级文案；null = 未命中
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      if (!/^(?:#|\/)status$/i.test(t)) return null;

      const client = ctx.client;
      if (!client || typeof client.call !== 'function') return STATUS_HELP;

      const started = Date.now();
      Promise.allSettled([
        client.call('get_login_info'),
        client.call('get_version_info'),
        client.call('get_status'),
      ]).then(([loginR, verR, statR]) => {
        const login = valueOf(loginR) || {};
        const ver = valueOf(verR) || {};
        const stat = valueOf(statR) || {};
        const okCount = [loginR, verR, statR].filter((r) => r.status === 'fulfilled').length;
        const elapsed = Date.now() - started;

        const account = login.user_id ?? client.selfId ?? '未知';
        const nick = login.nickname ? `（${login.nickname}）` : '';
        const appName = ver.app_name || 'NapCat';
        const appVer = ver.app_version || '未知';
        const protocol = ver.protocol_version ? `OneBot 11（${ver.protocol_version}）` : 'OneBot 11';
        const online = stat.online === true ? '在线' : stat.online === false ? '离线' : '未知';
        const good = stat.good === true ? '正常' : stat.good === false ? '异常' : '未知';

        const msg = [
          '【NapCat 平台状态】',
          `账号：${account}${nick}`,
          `平台：${appName} v${appVer}`,
          `协议：${protocol}`,
          `状态：${online} / ${good}`,
          `WS：${wsState(client)}`,
          `接口：${okCount}/3 正常`,
          `查询耗时：${elapsed} ms`,
          `Bot 运行时长：${formatUptime(process.uptime())}`,
        ].join('\n');

        const send = ctx.userId
          ? client.sendGroupMsgAt(ctx.groupId, ctx.userId, msg)
          : client.sendGroupMsg(ctx.groupId, msg);
        if (send && typeof send.catch === 'function') send.catch(() => {});
      }).catch(() => {}); // 发送/格式化异常吞掉（与 refresh 的回执发送容错一致）

      return true;
    },
  };
}

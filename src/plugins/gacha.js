/*
 * 抽卡/卡池领域指令插件（P2 由 commands.js 规则 9–11 整段搬移，正则与文案一字未改）。
 *
 * 域内 5 个 if 块按原代码顺序排列（**顺序即优先级，禁止重排/合并正则**）：
 *   9.  整串 卡池/卡池列表：只列当前开放池（currentGachaPools），附 UP 干员与用法提示
 *   10a. 抽卡记录/我的抽卡/抽卡统计 [N]：最近 N 抽明细+累计（默认 10，收敛 1–50）；
 *        缺 analytics/groupId/userId 任一 → 「抽卡记录功能未启用」
 *   10b. 整串 谁最欧/群欧皇/欧气榜：本群 6★ 排行；守卫只查 analytics 与 groupId
 *   11.  单抽/抽卡/N连 [池]：N 连支持阿拉伯或中文数字（十连/一百连/一千连…，上限 MAX_PULLS=1000），
 *        池参数 = 数字序号（1 起）或池名关键字；
 *        负向前瞻 (?!记录|统计|历史) 排除歧义——「单抽记录/十连记录/抽卡统计」绝不能落到本规则
 * ——「抽卡记录/我的抽卡/抽卡统计」必须先于「单抽/N连/抽卡」是本域唯一顺序敏感点。
 * 抽卡/记库调 arkdb.pullFromPool + analytics.recordPull（概率与过滤逻辑在 arkdb.js 内，本文件只做格式化与落库）。
 * 超过一辆十连（>10 行，如一百连）时改用「合并转发」发送：每节点一整辆十连；
 * 超大抽数（如一千连）按单卡字节预算（CARD_BYTE_BUDGET）拆多张卡依次发
 * （ctx.client.sendGroupForward，自驱返回 true；单卡失败回退普通文本）——十连及以下照旧一条普通消息。
 * 全部不命中返回 null 交下一个优先级插件（stats 400）——跨域词头无碰撞（本域词头：
 * 卡池/卡池列表/抽卡记录/我的抽卡/抽卡统计/谁最欧/群欧皇/欧气榜/单抽/N连/抽卡）。
 *
 * 依赖：logger；服务经 ctx 注入。
 * 实例化点：src/plugins/index.js 以 descriptor 形式随 commandPlugins 数组交付 runtime 注册。
 */
import { PRIORITY } from '../core/registry.js';
import { log } from '../core/platform/logger.js';

// 十连及以下（≤10 行）照旧一条普通消息；更多（如一百连）改用「合并转发」，每节点一整辆十连（10 行）
const FORWARD_CHUNK = 10;
// 单次抽卡数量上限（防刷屏；「一千零一连」这类会被拒）
const MAX_PULLS = 1000;
// 单张合并转发卡的 JSON 体积上限（实测 18.9KB 可发、25KB 被 QQ 拒 retcode=1200；留余量）
const CARD_BYTE_BUDGET = 18000;
// 多卡之间的发送间隔（风控节流）
const CARD_GAP_MS = 600;

/**
 * 解析「N 连」的数量：支持阿拉伯数字与中文数字（十/二十/一百/一百零五/两百…）。
 * @param {string} s - 数量部分（不含「连」）
 * @returns {number} 解析结果；无法识别返回 0
 */
function parseCnCount(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let num = 0;
  for (const ch of s) {
    if (ch in digits) { num = digits[ch]; continue; }
    if (ch in units) { total += (num || 1) * units[ch]; num = 0; continue; }
    return 0;
  }
  return total + num;
}

/**
 * 发送抽卡结果：行数 ≤ FORWARD_CHUNK（十连及以下，或 ctx 无 client）→ 返回文案由路由发送；
 * 超过则按每节点一整辆十连打包成「卡」、合并转发到群（自驱）并返回 true。单卡 JSON 体积
 * 超过 CARD_BYTE_BUDGET 时拆多张卡依次发送（QQ 实测拒 >25KB 转发）；单卡失败兜底补发普通文本。
 * @param {Object} ctx - 分发上下文（需 client/groupId/userName；缺 client 时退化为返回文案）
 * @param {string} header - 结果头（卡池/UP 信息）
 * @param {string[]} lines - 逐抽结果行
 * @returns {string|true} 文案（路由发送）或 true（已自驱转发）
 */
function sendPullResult(ctx, header, lines) {
  if (lines.length <= FORWARD_CHUNK || !ctx.client || typeof ctx.client.sendGroupForward !== 'function') {
    return `${header}\n${lines.join('\n')}`;
  }
  const uin = ctx.client.selfId || 0;
  const nodeBytes = (name, content) => Buffer.byteLength(JSON.stringify({ type: 'node', data: { uin, name, content } }), 'utf8') + 1;
  // 装箱：按字节预算把「十连批」装入卡（每卡再配一个头节点）
  const cards = [];
  let cur = { nodes: [], bytes: 0 };
  for (let i = 0; i < lines.length; i += FORWARD_CHUNK) {
    const end = Math.min(i + FORWARD_CHUNK, lines.length);
    const name = `第 ${i + 1}-${end} 抽`;
    const content = lines.slice(i, end).join('\n');
    const bytes = nodeBytes(name, content);
    if (cur.nodes.length && cur.bytes + bytes > CARD_BYTE_BUDGET) {
      cards.push(cur);
      cur = { nodes: [], bytes: 0 };
    }
    cur.nodes.push({ type: 'node', data: { uin, name, content } });
    cur.bytes += bytes;
  }
  if (cur.nodes.length) cards.push(cur);

  const total = cards.length;
  let sent = 0;
  const sendCards = async () => {
    for (let k = 0; k < total; k++) {
      const tag = total > 1 ? `｜第 ${k + 1}/${total} 卡` : '';
      const head = { type: 'node', data: { uin, name: 'Mon3tr 抽卡', content: `${header}（${ctx.userName || '群友'}${tag}）` } };
      await ctx.client.sendGroupForward(ctx.groupId, [head, ...cards[k].nodes]);
      sent++;
      if (k < total - 1) await new Promise((r) => setTimeout(r, CARD_GAP_MS));
    }
  };
  sendCards().catch((e) => {
    log(`[gacha] 合并转发失败（已发 ${sent}/${total} 卡）: ${e.message}`);
    // 单卡且一张未发出时才回退普通文本（多卡部分成功后不再重发，避免刷屏）
    if (sent === 0 && total === 1) {
      ctx.client.sendGroupMsg(ctx.groupId, `${header}\n${lines.join('\n')}`).catch(() => {});
    }
  });
  return true;
}

/**
 * 插件描述符构造：{name:'gacha', priority: PRIORITY.gacha, handleMessage}。
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createGachaPlugin() {
  return {
    name: 'gacha',
    priority: PRIORITY.gacha,
    /**
     * 卡池/抽卡分发：命中返回回复文案，未命中返回 null。
     * @param {Object} ctx - 消息上下文：{arkdb, analytics, groupId, userId, userName, text}
     * @returns {string|null} 回复文案或 null（未命中）
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      let m;

      // 整串「卡池/卡池列表」：列出当前开放的卡池（无开放池则提示），每个池附 UP 干员与用法提示
      if (t === '卡池' || t === '卡池列表') {
        const pools = ctx.arkdb.currentGachaPools();
        if (!pools.length) return '当前没有开放的卡池';
        const lines = pools.map((p, i) => {
          const { up6, up5 } = ctx.arkdb.poolRateUps(p);
          const up6Names = up6.map((id) => ctx.arkdb.characters.get(id)?.name || id);
          const up5Names = up5.map((id) => ctx.arkdb.characters.get(id)?.name || id);
          const ups = [];
          if (up6Names.length) ups.push(`6★UP：${up6Names.join('/')}`);
          if (up5Names.length) ups.push(`5★UP：${up5Names.join('/')}`);
          const label = p.guaranteeName || p.gachaRuleType || '';
          return `${i + 1}. ${label ? `[${label}] ` : ''}${p.gachaPoolName}${ups.length ? `（${ups.join('，')}）` : ''}`;
        });
        return '【当前卡池】\n' + lines.join('\n') + '\n\n用法：十连 1 / 一百连 2 / 单抽 卡池名关键字';
      }

      // 抽卡记录/我的抽卡/抽卡统计 [N]：最近抽到的 N 个 6★ 明细 + 累计统计（默认 10，收敛到 1–50）；
      // 缺 analytics/groupId/userId 任一 → 「抽卡记录功能未启用」（本规则必须先于下方单抽/十连规则）
      if ((m = t.match(/^(抽卡记录|我的抽卡|抽卡统计)\s*(\d*)$/))) {
        if (!ctx.analytics || ctx.groupId === undefined || ctx.userId === undefined) return '抽卡记录功能未启用';
        const limit = Math.min(Math.max(parseInt(m[2] || '10', 10) || 10, 1), 50);
        const rows = ctx.analytics.mySixPulls(ctx.groupId, ctx.userId, limit);
        const { total, six, five } = ctx.analytics.myPulls(ctx.groupId, ctx.userId, 1);
        if (!rows.length) {
          return total > 0
            ? `还没有抽到过 6★（累计 ${total} 抽），再试试吧~`
            : '你还没有抽卡记录，试试「十连」吧';
        }
        const list = rows.map((r, i) => `${i + 1}. ${r.operator}${r.is_up ? ' ↑UP' : ''}（${r.pool_name}）`).join('\n');
        return `【最近抽到的 6★（${rows.length} 个）】\n${list}\n\n累计 ${total} 抽 | 6★ ×${six} | 5★ ×${five}`;
      }
      // 整串「谁最欧/群欧皇/欧气榜」：本群欧气排行（按 6★ 数量）；守卫只查 analytics 与 groupId
      if (t === '谁最欧' || t === '群欧皇' || t === '欧气榜') {
        if (!ctx.analytics || ctx.groupId === undefined) return '欧气榜功能未启用';
        const rows = ctx.analytics.luckiest(ctx.groupId);
        if (!rows.length) return '本群还没有抽卡记录';
        return '【本群欧气榜（按6★数量）】\n' + rows.map((r, i) => `${i + 1}. ${r.name}：${r.six} 个6★ / ${r.total} 抽`).join('\n');
      }

      // 单抽/抽卡/N连 [池]：N 连支持阿拉伯与中文数字（十连、一百连…，上限 MAX_PULLS）；
      // 池参数 = 数字序号（1 起）或池名关键字（负向断言排除「记录/统计/历史」开头的歧义）；
      // 无开放池降级常驻模拟 randomPull；有池则 pullFromPool，且 analytics+groupId+userId 齐全时逐抽记库
      if ((m = t.match(/^(单抽|抽卡|(?:\d+|[零一二两三四五六七八九十百千]+)连)(?:\s+(?!记录|统计|历史)(.*))?$/))) {
        const kind = m[1];
        const arg = (m[2] || '').trim();
        let count = 10;
        if (kind === '单抽') count = 1;
        else if (kind !== '抽卡') count = parseCnCount(kind.slice(0, -1));
        if (count < 1 || count > MAX_PULLS) return `一次最多 ${MAX_PULLS} 连`;
        const label = count === 1 ? '单抽' : count === 10 ? '十连' : `${count}连`;
        const pools = ctx.arkdb.currentGachaPools();
        if (!pools.length) {
          const results = ctx.arkdb.randomPull(count);
          return sendPullResult(ctx, `【${label}·常驻模拟】`, results.map((r) => `${r.star} ${r.name}`));
        }
        let pool = pools[0];
        if (arg) {
          if (/^\d+$/.test(arg)) {
            pool = pools[parseInt(arg, 10) - 1] || pools[0];
          } else {
            const hit = pools.find((p) => p.gachaPoolName.includes(arg) || String(p.gachaPoolId).toLowerCase().includes(arg.toLowerCase()));
            if (hit) pool = hit;
          }
        }
        const { up6, up5 } = ctx.arkdb.poolRateUps(pool);
        const up6Names = up6.map((id) => ctx.arkdb.characters.get(id)?.name || id);
        const up5Names = up5.map((id) => ctx.arkdb.characters.get(id)?.name || id);
        const upDesc = up6Names.length || up5Names.length
          ? `（6★UP：${up6Names.join('/') || '无'}；5★UP：${up5Names.join('/') || '无'}）`
          : '';
        const poolName = pool?.gachaPoolName || '常驻模拟';
        const results = ctx.arkdb.pullFromPool(pool, count);
        // 记录抽卡历史
        if (ctx.analytics && ctx.groupId !== undefined && ctx.userId !== undefined) {
          for (const r of results) {
            ctx.analytics.recordPull(ctx.groupId, ctx.userId, ctx.userName || '', poolName, r.star, r.name, r.up);
          }
        }
        const formatted = results.map((r) => `${r.star} ${r.name}${r.up ? ' ↑UP' : ''}`);
        return sendPullResult(ctx, `【${label}·${poolName}】${upDesc}`, formatted);
      }

      return null;
    },
  };
}

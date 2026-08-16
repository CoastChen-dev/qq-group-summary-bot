import { log } from './logger.js';

// 群友纠错/学习循环 + 确定性任务指令。
// ctx: { lingo, arkdb, analytics }
export function tryCommand(ctx, text) {
  const t = String(text || '').trim();
  let m;

  // ---- 词典学习 / 维护 ----
  if ((m = t.match(/^(学习|纠正|记|定义)\s+(.+?)\s*[=＝：:]\s*(.+)$/)) || (m = t.match(/^(学习|纠正|记|定义)\s+(\S{1,20})\s+(.+)$/))) {
    const term = m[2].trim();
    const meaning = m[3].trim();
    if (meaning.length < 2) return '释义太短了，请用「学习 词=释义」的格式，比如：学习 轮椅轴=指用强力干员挂机过关的套路';
    ctx.lingo.learn(term, meaning);
    log(`[cmd] 学习词条: ${term} → ${meaning.slice(0, 30)}`);
    return `已学习词条：${term} → ${meaning}`;
  }

  if ((m = t.match(/^(忘记|删除|删)\s+(\S{1,20})$/))) {
    const ok = ctx.lingo.delete(m[2].trim());
    return ok ? `已忘记词条：${m[2].trim()}` : `词典中没有「${m[2].trim()}」`;
  }

  if ((m = t.match(/^(查词|词典查|释义)\s+(\S.{0,30})$/))) {
    const hit = ctx.lingo.lookup(m[2].trim());
    return hit ? `【词典】${hit.term}：${hit.meaning}` : `词典中没有「${m[2].trim()}」`;
  }

  if (t === '词典' || t === '词条数') {
    const keys = [...ctx.lingo.entries.keys()];
    return `当前词典共 ${keys.length} 条。\n${keys.slice(0, 30).join('、')}${keys.length > 30 ? ' …' : ''}`;
  }

  // ---- 干员查询 ----
  if ((m = t.match(/^(查干员|干员)\s+(\S{1,10})$/))) {
    const op = ctx.arkdb.findByName(m[2]) || ctx.arkdb.findOperatorFuzzy(m[2]);
    if (op) {
      const lines = [
        `【干员】${op.name}`,
        op.birthday ? `生日：${op.birthday}` : '',
        op.gender ? `性别：${op.gender}` : '',
        op.race ? `种族：${op.race}` : '',
        op.height ? `身高：${op.height}` : '',
        op.desc ? `简介：${op.desc.slice(0, 120)}` : '',
      ].filter(Boolean);
      return lines.join('\n');
    }
    return `未找到干员「${m[2]}」，可以试试精确名字，或问「XX是谁」`;
  }

  // ---- 藏品查询 ----
  if ((m = t.match(/^(查藏品|藏品)\s+(\S.{0,14})$/))) {
    const relic = ctx.arkdb.findRelic(m[2]) || ctx.arkdb.findRelicFuzzy(m[2]);
    if (relic && relic.name && relic.usage) {
      return `【藏品】${relic.name}\n效果：${relic.usage}\n描述：${relic.description || ''}`;
    }
    return `未找到藏品「${m[2]}」`;
  }

  // ---- 生日 ----
  if ((m = t.match(/^(干员生日|生日)\s+(\S{1,10})$/))) {
    const op = ctx.arkdb.findByName(m[2]) || ctx.arkdb.findOperatorFuzzy(m[2]);
    if (op) return op.birthday ? `【生日】${op.name}：${op.birthday}` : `资料中没有 ${op.name} 的生日记录`;
    return `未找到干员「${m[2]}」`;
  }

  if (t === '今日生日' || t === '今天谁生日') {
    const now = new Date();
    const list = ctx.arkdb.todaysBirthdays(now);
    return list.length
      ? `今天（${now.getMonth() + 1}月${now.getDate()}日）过生日的干员：\n${list.join('、')}`
      : '今天没有干员过生日';
  }

  // ---- 抽卡（真实卡池）----
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
    return '【当前卡池】\n' + lines.join('\n') + '\n\n用法：十连 1 / 单抽 卡池名关键字';
  }

  // ---- 抽卡记录 / 欧气榜（先于抽卡命令，避免"抽卡记录"被"抽卡"匹配）----
  if ((m = t.match(/^(抽卡记录|我的抽卡|抽卡统计)\s*(\d*)$/))) {
    if (!ctx.analytics || ctx.groupId === undefined || ctx.userId === undefined) return '抽卡记录功能未启用';
    const limit = Math.min(Math.max(parseInt(m[2] || '10', 10) || 10, 1), 50);
    const { rows, total, six, five } = ctx.analytics.myPulls(ctx.groupId, ctx.userId, limit);
    if (!rows.length) return '你还没有抽卡记录，试试「十连」吧';
    const list = rows.map((r) => `${r.star} ${r.operator}${r.is_up ? ' ↑UP' : ''}（${r.pool_name}）`).join('\n');
    return `【你的抽卡记录（最近 ${rows.length} 抽）】\n${list}\n\n累计 ${total} 抽 | 6★ ×${six} | 5★ ×${five}`;
  }
  if (t === '谁最欧' || t === '群欧皇' || t === '欧气榜') {
    if (!ctx.analytics || ctx.groupId === undefined) return '欧气榜功能未启用';
    const rows = ctx.analytics.luckiest(ctx.groupId);
    if (!rows.length) return '本群还没有抽卡记录';
    return '【本群欧气榜（按6★数量）】\n' + rows.map((r, i) => `${i + 1}. ${r.name}：${r.six} 个6★ / ${r.total} 抽`).join('\n');
  }

  if ((m = t.match(/^(单抽|十连|抽卡)(?:\s+(?!记录|统计|历史)(.*))?$/))) {
    const kind = m[1];
    const arg = (m[2] || '').trim();
    const count = kind === '单抽' ? 1 : 10;
    const pools = ctx.arkdb.currentGachaPools();
    if (!pools.length) {
      const results = ctx.arkdb.randomPull(count);
      return `【${kind}·常驻模拟】\n${results.map((r) => `${r.star} ${r.name}`).join('\n')}`;
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
    const formatted = results.map((r) => `${r.star} ${r.name}${r.up ? ' ↑UP' : ''}`).join('\n');
    return `【${kind}·${poolName}】${upDesc}\n${formatted}`;
  }

  // ---- 统计（依赖 SQLite 分析层）----
  if ((m = t.match(/^(活跃榜|活跃统计|活跃度)\s*(\d*)$/))) {
    const days = Math.min(Math.max(parseInt(m[2] || '7', 10) || 7, 1), 90);
    return ctx.analytics ? ctx.analytics.topActive(days) : '统计功能未启用';
  }
  if (t === '群统计' || t === '消息统计') {
    return ctx.analytics ? ctx.analytics.groupStats() : '统计功能未启用';
  }

  return null;
}

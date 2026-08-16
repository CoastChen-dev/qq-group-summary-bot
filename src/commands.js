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

  // ---- 抽卡 ----
  if (t === '十连' || t === '十连抽') return `【十连】\n${ctx.arkdb.randomPull(10)}`;
  if (t === '单抽') return `【单抽】\n${ctx.arkdb.randomPull(1)}`;

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

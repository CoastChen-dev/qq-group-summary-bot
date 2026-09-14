/*
 * 用户记忆领域指令插件（priority 750，位于 lingo 700 之前）：记住/我的记忆/忘记我 三条规则。
 *
 * 为什么独立成域：与 lingo（梗词典，全群共享的知识）不同，本域是「关于某个群友」的私有记忆，
 * 按群隔离、按用户归属（见 core/platform/usermem.js）。词头与 lingo 无碰撞：「记住/记下」
 * 不等于 lingo 的「记 词=释义」（后者要求空白分隔）；「忘记我」不等于 lingo 的「忘记 词」
 * （后者要求空白分隔），且本带 750 先分发、双重保险。
 * 规则（域内顺序即优先级）：
 *   1. 记住/记下 …：写入当前用户的一条事实（同文重复提示已记住；<2 字拒绝）
 *   2. 整串 我的记忆/查看记忆/记忆列表：列当前用户在本群的事实
 *   3. 整串 忘记我/清空记忆：清空当前用户在本群的全部记忆
 * 缺 ctx.memory（config.memory.enabled=false）时三条规则都回「记忆功能未启用」。
 * 全部不命中返回 null 交下一个优先级插件（lingo 700）。
 *
 * 依赖：零（服务经 ctx.memory 注入）；实例化点：src/plugins/index.js 随 commandPlugins 数组交付 runtime。
 */
import { PRIORITY } from '../core/registry.js';

/**
 * 插件描述符构造：{name:'memory', priority: PRIORITY.memory, handleMessage}。
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createMemoryPlugin() {
  return {
    name: 'memory',
    priority: PRIORITY.memory,
    /**
     * 用户记忆维护分发：命中返回回复文案，未命中返回 null。
     * @param {Object} ctx - 消息上下文：{memory: UserMemory, groupId, userId, userName, text}
     * @returns {string|null} 回复文案或 null（未命中）
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      let m;

      // 记住/记下 …（内容 trim 后 ≥2 字；重复内容提示已记住）
      if ((m = t.match(/^(记住|记下)[:：,，\s]+(.+)$/))) {
        if (!ctx.memory) return '记忆功能未启用';
        const text = m[2].trim();
        if (text.length < 2) return '要记住的内容太短了，说「记住 …」就行';
        const r = ctx.memory.setFact(ctx.groupId, ctx.userId, ctx.userName, text, 'manual');
        return r.dup ? `这个我已经记住啦：${text}` : `（认真记下）记住了，博士：${text}`;
      }

      // 整串「我的记忆/查看记忆/记忆列表」：列当前用户在本群的事实
      if (t === '我的记忆' || t === '查看记忆' || t === '记忆列表') {
        if (!ctx.memory) return '记忆功能未启用';
        const facts = ctx.memory.listFacts(ctx.groupId, ctx.userId);
        if (!facts.length) return '还没有关于你的记忆呢，说「记住 …」我就会记住的~';
        return `【关于你的记忆】\n${facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n')}\n（共 ${facts.length} 条）`;
      }

      // 整串「忘记我/清空记忆」：清空当前用户在本群的记忆
      if (t === '忘记我' || t === '清空记忆') {
        if (!ctx.memory) return '记忆功能未启用';
        const ok = ctx.memory.forgetUser(ctx.groupId, ctx.userId);
        return ok ? '（尾巴耷拉下来）已经把关于你的记忆都忘掉了……' : '本来就没有关于你的记忆呀';
      }

      return null;
    },
  };
}

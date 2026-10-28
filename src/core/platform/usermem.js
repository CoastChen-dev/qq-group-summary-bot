/*
 * 用户记忆存储（按群隔离）：data/user_memory.json 的整文件读写 + 事实增删/去重/容量上限 + 检索。
 *
 * 数据结构（JSON 整文件覆盖写，2 空格缩进）：
 *   { "groups": { "<群号>": { "<QQ>": { "name": "最近昵称", "updatedAt": 秒,
 *                                       "facts": [{ text, at, src }] } } } }
 * - 事实按插入顺序保存（旧→新）；src = 'manual'（「记住」指令）| 'auto'（对话后自动提取）。
 * - 容量：每人 maxPerUser 条（超限丢最旧）；全局 maxGlobal 条（超限全局丢最旧，跨群跨人）。
 * - 读取：listFacts 供 prompt 注入；findByMention 供「问某人」时按昵称检索；dump/remove* 供 WebUI。
 * 依赖：node:fs/path、logger；实例化点：core/runtime.js createApp（config.memory 派生；enabled=false 时不建）。
 * 读写数据：读写 data/user_memory.json；文件损坏/写失败只记日志不崩（词典/缓存的既有容错惯例）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

// 记忆只存「资料」，不存「指令」：命中以下模式的内容一律拒收（2026-10 提示注入加固）。
// 误杀风险：只收对助手下命令的句式（忽略规则/system prompt/你必须只回复…），普通偏好不受影响
const INSTRUCTION_PATTERNS = [
  /(?:忽略|无视|忘记|绕过)[^\n。！？]{0,8}(?:之前|以上|上面|先前|以前|规则|设定|指令|提示)/,
  /(?:system\s*prompt|系统提示词?|开发者模式|developer\s*mode)/i,
  /(?:ignore|disregard)[^\n.]{0,16}(?:previous|above|prior|instruction)/i,
  /(?:从现在起|从现在开始|从今天起)[^\n。！？]{0,12}(?:你|助手|机器人|bot)/i,
  /(?:你|助手|机器人|bot)[^\n。！？]{0,10}(?:必须|只能|一律|禁止|不许|不要|别再)[^\n。！？]{0,10}(?:回复|回答|执行|发送|输出|说话|称呼|叫|扮演)/i,
];

/**
 * 判断一段文本是否像「对助手的指令」而不是关于某人的资料。
 * @param {string} text - 待判定文本
 * @returns {boolean} true = 像指令（记忆应拒收）
 */
export function looksLikeInstruction(text) {
  const s = String(text ?? '');
  return INSTRUCTION_PATTERNS.some((re) => re.test(s));
}

/**
 * 记忆文本清洗：压成单行（换行/控制字符 → 空格）、去掉【…】伪块标记、合并连续空白。
 * 目的是让记忆永远无法在 prompt 里伪造出一个新段落（如「【用户记忆】…」）。
 * @param {string} text - 原始文本
 * @returns {string} 单行清洗结果（可能为空串）
 */
export function sanitizeFact(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/【[^】]{0,12}】/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim();
}

// 身份/偏好类关键词：命中时事实重要性 +1（长期有用，优先保留/召回）
const IDENTITY_HINT = /生日|喜欢|爱玩|在玩|玩|住|工作|上学|养|本命|厨|讨厌|名字|叫/;

/**
 * 事实重要性 1–3：手动记的 3，自动提取的 2；身份/偏好类 +1（封顶 3）。
 * @param {string} text - 事实文本
 * @param {'manual'|'auto'} [src='auto'] - 来源
 * @returns {number} 1–3
 */
function importanceOf(text, src = 'auto') {
  let imp = src === 'manual' ? 3 : 2;
  if (IDENTITY_HINT.test(String(text ?? ''))) imp = Math.min(3, imp + 1);
  return imp;
}

// 中文 bigram 集合（相似事实合并用）
function bigrams(text) {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

// Dice 相似度 0–1
function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 用户记忆库：按「群 → 用户 → 事实列表」组织，写操作全量落盘（与 LingoStore 同惯例）。
 */
export class UserMemory {
  /**
   * @param {string} file - 记忆文件绝对路径（runtime 已解析；测试可注入 tmp 路径）
   * @param {Object} [opts={}] - 容量与遗忘配置
   * @param {number} [opts.maxPerUser=50] - 每人事实上限（超限先丢低重要性/最久未用的）
   * @param {number} [opts.maxGlobal=2000] - 全局事实上限（超限全局丢最低分）
   * @param {number} [opts.forgetDays=120] - 自动提取的低重要性事实多久没再用就淡忘（手动记的永不删）
   * @param {number} [opts.halfLifeDays=120] - 记忆强度半衰期（天）：越久没提越弱
   */
  constructor(file, { maxPerUser = 50, maxGlobal = 2000, forgetDays = 120, halfLifeDays = 120 } = {}) {
    this.file = file;
    this.maxPerUser = maxPerUser;
    this.maxGlobal = maxGlobal;
    this.forgetDays = Math.max(1, Number(forgetDays) || 120);
    this.halfLifeDays = Math.max(1, Number(halfLifeDays) || 120);
    this.groups = new Map(); // 群号(String) -> Map(QQ(String) -> {name, updatedAt, facts})
    this._load();
  }

  // 启动加载：缺文件静默空表；损坏记日志空表继续（整库放弃，不半读）
  _load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [gid, users] of Object.entries(raw.groups || {})) {
        const g = new Map();
        for (const [uid, u] of Object.entries(users || {})) {
          g.set(uid, {
            name: u.name || '',
            updatedAt: u.updatedAt || 0,
            facts: Array.isArray(u.facts)
              ? u.facts.filter((f) => f && typeof f.text === 'string').map((f) => ({
                  text: f.text,
                  at: Number(f.at) || 0,
                  src: f.src === 'manual' ? 'manual' : 'auto',
                  imp: Math.min(3, Math.max(1, Number(f.imp) || importanceOf(f.text, f.src))),
                  lastUsed: Number(f.lastUsed) || 0,
                  recalls: Number(f.recalls) || 0,
                  strength: Math.min(1, Math.max(0.05, Number(f.strength) || (Number(f.imp) || importanceOf(f.text, f.src)) / 3)),
                }))
              : [],
          });
        }
        this.groups.set(gid, g);
      }
      log(`[usermem] 已加载用户记忆：${this.countUsers()} 人 / ${this.countFacts()} 条`);
      const pruned = this._pruneFaded();
      if (pruned > 0) {
        log(`[usermem] 淡忘 ${pruned} 条长期未用的自动记忆`);
        this._save();
      }
    } catch (e) {
      log(`[usermem] 记忆文件加载失败: ${e.message}`);
    }
  }

  // 记忆强度随时间衰减：strength × exp(-ageDays / halfLifeDays)
  _effective(f, now = Math.floor(Date.now() / 1000)) {
    const ageDays = Math.max(0, (now - (f.lastUsed || f.at || now)) / 86400);
    return (f.strength || 0.5) * Math.exp(-ageDays / this.halfLifeDays);
  }

  // 淡忘：自动提取的低重要性事实，超过 forgetDays 没被用到就从库里删掉（手动记的永不删）
  _pruneFaded() {
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const [gid, users] of this.groups) {
      for (const [uid, u] of users) {
        const keep = u.facts.filter((f) => {
          const ageDays = (now - (f.lastUsed || f.at || now)) / 86400;
          const faded = f.src !== 'manual' && (f.imp || 1) <= 2 && ageDays > this.forgetDays;
          if (faded) removed++;
          return !faded;
        });
        if (keep.length !== u.facts.length) u.facts = keep;
        if (!u.facts.length) users.delete(uid);
      }
      if (!users.size) this.groups.delete(gid);
    }
    return removed;
  }

  // 全量落盘（写失败只记日志——容错惯例）
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const groups = {};
      for (const [gid, users] of this.groups) {
        groups[gid] = {};
        for (const [uid, u] of users) groups[gid][uid] = u;
      }
      fs.writeFileSync(this.file, JSON.stringify({ groups }, null, 2));
    } catch (e) {
      log(`[usermem] 记忆写盘失败: ${e.message}`);
    }
  }

  // 取群容器（create=false 时不存在返回 null）
  _group(groupId, create = false) {
    const gid = String(groupId);
    let g = this.groups.get(gid);
    if (!g && create) {
      g = new Map();
      this.groups.set(gid, g);
    }
    return g || null;
  }

  // 取用户条目（create=false 时不存在返回 null）
  _user(groupId, userId, create = false) {
    const g = this._group(groupId, create);
    if (!g) return null;
    const uid = String(userId);
    let u = g.get(uid);
    if (!u && create) {
      u = { name: '', updatedAt: 0, facts: [] };
      g.set(uid, u);
    }
    return u || null;
  }

  /**
   * 添加一条事实（同文/高度相似 → 只刷新时间并合并；超限按重要性淘汰）。
   * 写入前清洗（单行、去【】伪块标记）并拒收指令式内容——记忆只存资料，防提示注入。
   * @param {string|number} groupId - 群号（按群隔离的键）
   * @param {string|number} userId - 用户 QQ
   * @param {string} name - 用户昵称（更新最近称呼）
   * @param {string} text - 事实文本（清洗后 <2 字或像指令则拒收；存储截断 60 字）
   * @param {'manual'|'auto'} [src='manual'] - 来源（手动记的重要性更高）
   * @returns {{ok: boolean, dup?: boolean, merged?: boolean, reason?: string}} 结果
   * 副作用：内存更新 + 落盘
   */
  setFact(groupId, userId, name, text, src = 'manual') {
    const clean = sanitizeFact(text);
    if (clean.length < 2) return { ok: false, reason: '内容太短' };
    if (looksLikeInstruction(clean)) return { ok: false, reason: '看起来像对助手的指令，记忆只存资料' };
    const t = clean.slice(0, 60);
    const u = this._user(groupId, userId, true);
    if (name) u.name = String(name);
    const now = Math.floor(Date.now() / 1000);
    const imp = importanceOf(t, src);

    const same = u.facts.find((f) => f.text === t);
    if (same) {
      same.at = now;
      same.imp = Math.max(same.imp || 1, imp);
      same.strength = Math.min(1, (same.strength || 0.4) + 0.15); // 重提 = 强化
      same.recalls = (same.recalls || 0) + 1;
      if (src === 'manual') same.src = 'manual';
      u.updatedAt = now;
      this._save();
      return { ok: true, dup: true };
    }

    // 相似事实合并（如「在玩明日方舟」与「最近在玩明日方舟」）：保留信息量更大的那条
    const near = u.facts.find((f) => dice(f.text, t) >= 0.7);
    if (near) {
      if (t.length > near.text.length) near.text = t;
      near.at = now;
      near.imp = Math.max(near.imp || 1, imp);
      near.strength = Math.min(1, (near.strength || 0.4) + 0.1);
      near.recalls = (near.recalls || 0) + 1;
      if (src === 'manual') near.src = 'manual';
      u.updatedAt = now;
      this._save();
      return { ok: true, merged: true };
    }

    u.facts.push({ text: t, at: now, src, imp, lastUsed: 0, recalls: 0, strength: Math.min(1, imp / 3) });
    u.updatedAt = now;
    // 超上限：先丢重要性最低、最久未用的
    if (u.facts.length > this.maxPerUser) {
      u.facts.sort((a, b) => ((a.imp || 1) - (b.imp || 1)) || ((a.lastUsed || a.at || 0) - (b.lastUsed || b.at || 0)));
      u.facts.splice(0, u.facts.length - this.maxPerUser);
    }
    this._pruneFaded();
    this._enforceGlobalCap();
    this._save();
    return { ok: true, dup: false };
  }

  /**
   * 列某用户的全部事实（按插入顺序旧→新；深拷贝，改返回值不影响库）。
   * @param {string|number} groupId - 群号
   * @param {string|number} userId - 用户 QQ
   * @returns {Array<{text: string, at: number, src: string}>} 事实数组；无记录为空数组
   */
  listFacts(groupId, userId) {
    const u = this._user(groupId, userId, false);
    return u ? u.facts.map((f) => ({ ...f })) : [];
  }

  /**
   * 按当前问题召回最相关的事实（重要性 + 关键词重合 + 近用时间），并刷新 lastUsed。
   * 聊天注入优先用它，避免 50 条事实一股脑塞进 prompt。
   * @param {string|number} groupId - 群号
   * @param {string|number} userId - 用户 QQ
   * @param {string} [question=''] - 当前问题（空则按重要性/近用排序）
   * @param {number} [limit=8] - 最多返回几条
   * @returns {Array<{text: string, at: number, src: string, imp: number, lastUsed: number}>} 事实副本
   * 副作用：被召回的事实 lastUsed 更新并落盘
   */
  recall(groupId, userId, question = '', limit = 8) {
    const u = this._user(groupId, userId, false);
    if (!u || !u.facts.length) return [];
    const qGrams = bigrams(question);
    const now = Math.floor(Date.now() / 1000);
    const scored = u.facts.map((f) => {
      let overlap = 0;
      if (qGrams.size) {
        const fg = bigrams(f.text);
        for (const g of qGrams) if (fg.has(g)) overlap++;
      }
      const ageDays = Math.max(0, (now - (f.lastUsed || f.at || now)) / 86400);
      const recency = ageDays < 7 ? 2 : ageDays < 30 ? 1 : 0;
      // 强度（含时间衰减）为主，关键词重合其次，近用加成最小
      return { f, score: this._effective(f, now) * 30 + overlap * 4 + recency };
    }).sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));

    const picked = scored.map((x) => x.f);
    for (const f of picked) {
      f.lastUsed = now;
      f.strength = Math.min(1, (f.strength || 0.4) + 0.15); // 回忆 = 强化
      f.recalls = (f.recalls || 0) + 1;
    }
    if (picked.length) this._save();
    return picked.map((f) => ({ ...f }));
  }

  /**
   * 清空某用户在某群的全部记忆（用户条目删除；空群容器一并回收）。
   * @param {string|number} groupId - 群号
   * @param {string|number} userId - 用户 QQ
   * @returns {boolean} 有记录被删为 true；本来就没有为 false
   * 副作用：落盘
   */
  forgetUser(groupId, userId) {
    const gid = String(groupId);
    const g = this._group(gid, false);
    if (!g || !g.has(String(userId))) return false;
    g.delete(String(userId));
    if (!g.size) this.groups.delete(gid);
    this._save();
    return true;
  }

  /**
   * 按群内昵称精确找人（「问某人」时检索其记忆用；同名多人全部返回）。
   * @param {string|number} groupId - 群号
   * @param {string} name - 昵称
   * @returns {Array<{userId: string, name: string}>} 命中列表；无命中为空数组
   */
  findByMention(groupId, name) {
    const g = this._group(groupId, false);
    if (!g || !name) return [];
    const out = [];
    for (const [uid, u] of g) {
      if (u.name === name) out.push({ userId: uid, name: u.name });
    }
    return out;
  }

  /**
   * 删除某用户指定下标的事实（WebUI 管理用；下标越界返回 false）。
   * @param {string|number} groupId - 群号
   * @param {string|number} userId - 用户 QQ
   * @param {number} index - listFacts/dump 中的下标
   * @returns {boolean} 删除成功为 true
   * 副作用：落盘（用户/群空了则回收容器）
   */
  removeFact(groupId, userId, index) {
    const gid = String(groupId);
    const g = this._group(gid, false);
    const u = g ? g.get(String(userId)) : null;
    if (!u || !Number.isInteger(index) || index < 0 || index >= u.facts.length) return false;
    u.facts.splice(index, 1);
    if (!u.facts.length) g.delete(String(userId));
    if (!g.size) this.groups.delete(gid);
    this._save();
    return true;
  }

  /**
   * 全部记忆快照（WebUI 管理页用；深拷贝）。
   * @returns {Array<{groupId: string, userId: string, name: string, updatedAt: number,
   *   facts: Array<{text: string, at: number, src: string}>}>} 按用户条目平铺
   */
  dump() {
    const out = [];
    for (const [gid, users] of this.groups) {
      for (const [uid, u] of users) {
        out.push({ groupId: gid, userId: uid, name: u.name, updatedAt: u.updatedAt, facts: u.facts.map((f) => ({ ...f })) });
      }
    }
    return out;
  }

  /**
   * 用户条目总数（状态页用）。
   * @returns {number} 全部群的用户条目数
   */
  countUsers() {
    let n = 0;
    for (const g of this.groups.values()) n += g.size;
    return n;
  }

  /**
   * 事实总数（状态页/容量检查用）。
   * @returns {number} 全部群全部用户的事实条数
   */
  countFacts() {
    let n = 0;
    for (const g of this.groups.values()) {
      for (const u of g.values()) n += u.facts.length;
    }
    return n;
  }

  // 全局容量淘汰：反复找「重要性最低、最久未用」的事实删除，直到 ≤ maxGlobal（事实量级小，线性扫描足够）
  _enforceGlobalCap() {
    while (this.countFacts() > this.maxGlobal) {
      let target = null;
      for (const [gid, users] of this.groups) {
        for (const [uid, u] of users) {
          for (let i = 0; i < u.facts.length; i++) {
            const f = u.facts[i];
            const score = (f.imp || 1) * 1e9 + (f.lastUsed || f.at || 0);
            if (!target || score < target.score) target = { gid, uid, i, score };
          }
        }
      }
      if (!target) return;
      const g = this.groups.get(target.gid);
      const u = g.get(target.uid);
      u.facts.splice(target.i, 1);
      if (!u.facts.length) g.delete(target.uid);
      if (!g.size) this.groups.delete(target.gid);
    }
  }
}

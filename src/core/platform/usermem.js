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

/**
 * 用户记忆库：按「群 → 用户 → 事实列表」组织，写操作全量落盘（与 LingoStore 同惯例）。
 */
export class UserMemory {
  /**
   * @param {string} file - 记忆文件绝对路径（runtime 已解析；测试可注入 tmp 路径）
   * @param {Object} [opts={}] - 容量配置
   * @param {number} [opts.maxPerUser=20] - 每人事实上限（超限丢最旧）
   * @param {number} [opts.maxGlobal=2000] - 全局事实上限（超限全局丢最旧）
   */
  constructor(file, { maxPerUser = 20, maxGlobal = 2000 } = {}) {
    this.file = file;
    this.maxPerUser = maxPerUser;
    this.maxGlobal = maxGlobal;
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
            facts: Array.isArray(u.facts) ? u.facts.filter((f) => f && typeof f.text === 'string') : [],
          });
        }
        this.groups.set(gid, g);
      }
      log(`[usermem] 已加载用户记忆：${this.countUsers()} 人 / ${this.countFacts()} 条`);
    } catch (e) {
      log(`[usermem] 记忆文件加载失败: ${e.message}`);
    }
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
   * 添加一条事实（同文重复 → 只刷新时间并标记 dup；超限触发容量淘汰）。
   * @param {string|number} groupId - 群号（按群隔离的键）
   * @param {string|number} userId - 用户 QQ
   * @param {string} name - 用户昵称（更新最近称呼）
   * @param {string} text - 事实文本（trim 后 <2 字拒收；存储截断 60 字）
   * @param {'manual'|'auto'} [src='manual'] - 来源
   * @returns {{ok: boolean, dup?: boolean, reason?: string}} 结果
   * 副作用：内存更新 + 落盘
   */
  setFact(groupId, userId, name, text, src = 'manual') {
    const t = String(text || '').trim();
    if (t.length < 2) return { ok: false, reason: '内容太短' };
    const u = this._user(groupId, userId, true);
    if (name) u.name = String(name);
    const now = Math.floor(Date.now() / 1000);
    const dup = u.facts.find((f) => f.text === t);
    if (dup) {
      dup.at = now;
      u.updatedAt = now;
      this._save();
      return { ok: true, dup: true };
    }
    u.facts.push({ text: t.slice(0, 60), at: now, src });
    u.updatedAt = now;
    if (u.facts.length > this.maxPerUser) u.facts.splice(0, u.facts.length - this.maxPerUser);
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

  // 全局容量淘汰：反复找全局 at 最小的事实删除，直到 ≤ maxGlobal（事实量级小，线性扫描足够）
  _enforceGlobalCap() {
    while (this.countFacts() > this.maxGlobal) {
      let target = null;
      for (const [gid, users] of this.groups) {
        for (const [uid, u] of users) {
          for (let i = 0; i < u.facts.length; i++) {
            const at = u.facts[i].at || 0;
            if (!target || at < target.at) target = { gid, uid, i, at };
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

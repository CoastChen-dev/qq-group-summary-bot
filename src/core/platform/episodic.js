/**
 * 情节记忆（2026-10）：按群、按天存「今天群里发生了什么」的几条小事，
 * 供后续对话把最近几天的背景注入 prompt（只作语境，不逐条复述）。
 *
 * 存储：data/memory/<群号>/<YYYY-MM-DD>.json
 *   { "date": "2026-10-28", "items": ["...", "..."], "generatedAt": 秒 }
 * 生成：日报生成成功后由 report 插件调 Summarizer.extractMemories() 提炼并 save()。
 * 读取：ChatBrain.buildMessages 用 format() 取最近 N 天、限长拼成一段背景。
 * 依赖：node:fs/path、logger；实例化点 core/runtime.js createApp。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';
import { writeFileAtomic } from './atomic.js';

/** 群号 → 安全目录名（防路径穿越） */
const safeGid = (gid) => String(gid ?? '').replace(/[^\w.-]/g, '_');

export class EpisodicMemory {
  /**
   * @param {string} dir - 根目录（如 data/memory）
   * @param {Object} [opts={}]
   * @param {number} [opts.days=3] - 默认注入最近几天的记忆
   * @param {number} [opts.maxChars=500] - 注入总长上限
   * @param {number} [opts.retentionDays=30] - 磁盘上保留多少天（更早的删除，像人会淡忘久远的细节）
   */
  constructor(dir, { days = 3, maxChars = 500, retentionDays = 30 } = {}) {
    this.dir = dir;
    this.days = Math.max(0, Number(days) || 0);
    this.maxChars = Math.max(0, Number(maxChars) || 0);
    this.retentionDays = Math.max(1, Number(retentionDays) || 30);
  }

  _groupDir(gid) {
    return path.join(this.dir, safeGid(gid));
  }

  _file(gid, date) {
    return path.join(this._groupDir(gid), `${date}.json`);
  }

  /**
   * 保存某群某天的记忆（覆盖同一天）。
   * @param {string|number} gid - 群号
   * @param {string} date - YYYY-MM-DD
   * @param {string[]} items - 3-5 条小事（空数组不写）
   * @returns {boolean} 是否写入
   */
  save(gid, date, items) {
    const list = (Array.isArray(items) ? items : [])
      .map((s) => String(s || '').trim().slice(0, 80))
      .filter((s) => s.length >= 2)
      .slice(0, 5);
    if (!list.length || !date) return false;
    try {
      writeFileAtomic(this._file(gid, date), JSON.stringify({
        date, items: list, generatedAt: Math.floor(Date.now() / 1000),
      })); // 原子替换（2026-10）
      this._pruneOld(gid);
      return true;
    } catch (e) {
      log(`[episodic] 群 ${gid} 记忆写盘失败: ${e.message}`);
      return false;
    }
  }

  // 删除超过 retentionDays 的旧记忆文件（按文件名日期比较；失败忽略）
  _pruneOld(gid) {
    const cutoff = new Date(Date.now() - this.retentionDays * 86400000).toISOString().slice(0, 10);
    let files = [];
    try {
      files = fs.readdirSync(this._groupDir(gid));
    } catch {
      return;
    }
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m && m[1] < cutoff) {
        try { fs.rmSync(path.join(this._groupDir(gid), f), { force: true }); } catch { /* 忽略 */ }
      }
    }
  }

  /**
   * 取最近 N 天的记忆（日期升序）。
   * @param {string|number} gid - 群号
   * @param {number} [days=this.days] - 天数
   * @returns {Array<{date: string, items: string[]}>} 缺失/损坏的天跳过
   */
  recent(gid, days = this.days) {
    if (days <= 0) return [];
    let files;
    try {
      files = fs.readdirSync(this._groupDir(gid)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files.sort().slice(-days)) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this._groupDir(gid), f), 'utf8'));
        if (d && Array.isArray(d.items) && d.items.length) out.push({ date: d.date || f.slice(0, 10), items: d.items });
      } catch { /* 损坏的天跳过 */ }
    }
    return out;
  }

  /**
   * 拼成 prompt 用的一段背景（日期 + 条目，截到 maxChars）。
   * @param {string|number} gid - 群号
   * @param {number} [days=this.days] - 最近几天
   * @param {number} [maxChars=this.maxChars] - 长度上限
   * @returns {string} 空串 = 没有记忆
   */
  format(gid, days = this.days, maxChars = this.maxChars) {
    const entries = this.recent(gid, days);
    if (!entries.length) return '';
    // 带上相对时间（今天/昨天/N 天前），让「记忆随时间变淡」在 prompt 里可见
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 86400000;
    const lines = entries.map((e) => {
      const t = new Date(`${e.date}T00:00:00`).getTime();
      const diff = Number.isFinite(t) ? Math.round((base - t) / dayMs) : 0;
      const rel = diff <= 0 ? '今天' : diff === 1 ? '昨天' : `${diff}天前`;
      return `- ${e.date.slice(5)}（${rel}）：${e.items.join('；')}`;
    });
    let text = lines.join('\n');
    if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars) + '…';
    return text;
  }
}

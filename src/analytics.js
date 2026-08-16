import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

// 基于 SQLite 的消息分析层：从 JSONL 一次性导入，之后每条新消息实时记录。
// 用于活跃榜、群统计等聚合查询（JSONL 不适合此类查询）。
export class Analytics {
  constructor(dbPath, messagesDir) {
    this.dbPath = dbPath;
    this.messagesDir = messagesDir;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        time INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        UNIQUE(group_id, msg_id)
      );
      CREATE INDEX IF NOT EXISTS idx_time ON messages(time);
      CREATE INDEX IF NOT EXISTS idx_group_user ON messages(group_id, user_id);
      CREATE TABLE IF NOT EXISTS pulls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL,
        pool_name TEXT NOT NULL DEFAULT '',
        star TEXT NOT NULL DEFAULT '',
        operator TEXT NOT NULL DEFAULT '',
        is_up INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_pulls_group_user ON pulls(group_id, user_id);
    `);
    this._imported = false;
  }

  // 首次使用时从 JSONL 归档导入（幂等：UNIQUE 约束去重）
  _ensureImported() {
    if (this._imported) return;
    this._imported = true;
    try {
      const dirs = fs.existsSync(this.messagesDir) ? fs.readdirSync(this.messagesDir) : [];
      let total = 0;
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO messages (group_id, msg_id, time, user_id, name, text) VALUES (?,?,?,?,?,?)'
      );
      for (const gid of dirs) {
        const gdir = path.join(this.messagesDir, gid);
        if (!fs.statSync(gdir).isDirectory()) continue;
        for (const f of fs.readdirSync(gdir)) {
          if (!f.endsWith('.jsonl')) continue;
          const lines = fs.readFileSync(path.join(gdir, f), 'utf8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const r = JSON.parse(line);
              stmt.run(String(gid), String(r.id), r.time ?? 0, String(r.userId ?? ''), r.name ?? '', r.text ?? '');
              total++;
            } catch { /* skip bad line */ }
          }
        }
      }
      if (total > 0) log(`[analytics] 已从 JSONL 导入 ${total} 条消息到 SQLite`);
    } catch (e) {
      log(`[analytics] 导入失败: ${e.message}`);
    }
  }

  record(groupId, rec) {
    this._ensureImported();
    try {
      this.db.prepare(
        'INSERT OR IGNORE INTO messages (group_id, msg_id, time, user_id, name, text) VALUES (?,?,?,?,?,?)'
      ).run(String(groupId), String(rec.id), rec.time ?? 0, String(rec.userId ?? ''), rec.name ?? '', rec.text ?? '');
    } catch { /* 忽略写入失败 */ }
  }

  topActive(days = 7) {
    this._ensureImported();
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = this.db.prepare(
      `SELECT name, COUNT(*) AS cnt FROM messages WHERE time >= ? AND name != '' AND name != '未知'
       GROUP BY user_id ORDER BY cnt DESC LIMIT 10`
    ).all(since);
    if (!rows.length) return `最近 ${days} 天没有消息记录`;
    return `【最近 ${days} 天活跃榜】\n` + rows.map((r, i) => `${i + 1}. ${r.name}（${r.cnt} 条）`).join('\n');
  }

  groupStats() {
    this._ensureImported();
    const rows = this.db.prepare(
      `SELECT group_id, COUNT(*) AS cnt, MAX(time) AS last FROM messages GROUP BY group_id ORDER BY cnt DESC`
    ).all();
    if (!rows.length) return '暂无消息统计';
    const now = Math.floor(Date.now() / 1000);
    return '【群消息统计】\n' + rows.map((r) => {
      const days = Math.floor((now - r.last) / 86400);
      return `群 ${r.group_id}：${r.cnt} 条（最近活跃 ${days} 天前）`;
    }).join('\n');
  }

  // ---- 抽卡记录 ----
  recordPull(groupId, userId, userName, poolName, star, operator, isUp) {
    try {
      this.db.prepare(
        'INSERT INTO pulls (group_id, user_id, name, time, pool_name, star, operator, is_up) VALUES (?,?,?,?,?,?,?,?)'
      ).run(String(groupId), String(userId), userName || '', Math.floor(Date.now() / 1000), poolName || '', star || '', operator || '', isUp ? 1 : 0);
    } catch { /* 忽略 */ }
  }

  myPulls(groupId, userId, limit = 10) {
    const rows = this.db.prepare(
      'SELECT pool_name, star, operator, is_up, time FROM pulls WHERE group_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?'
    ).all(String(groupId), String(userId), limit);
    const total = this.db.prepare(
      'SELECT COUNT(*) AS c FROM pulls WHERE group_id = ? AND user_id = ?'
    ).get(String(groupId), String(userId))?.c ?? 0;
    const six = this.db.prepare(
      `SELECT COUNT(*) AS c FROM pulls WHERE group_id = ? AND user_id = ? AND star LIKE '%★★★★★★%'`
    ).get(String(groupId), String(userId))?.c ?? 0;
    const five = this.db.prepare(
      `SELECT COUNT(*) AS c FROM pulls WHERE group_id = ? AND user_id = ? AND star LIKE '%★★★★★%' AND star NOT LIKE '%★★★★★★%'`
    ).get(String(groupId), String(userId))?.c ?? 0;
    return { rows, total, six, five };
  }

  luckiest(groupId) {
    const rows = this.db.prepare(
      `SELECT name, user_id, COUNT(*) AS total,
              SUM(CASE WHEN star LIKE '%★★★★★★%' THEN 1 ELSE 0 END) AS six
       FROM pulls WHERE group_id = ?
       GROUP BY user_id HAVING total > 0 ORDER BY six DESC, total DESC LIMIT 10`
    ).all(String(groupId));
    return rows;
  }
}

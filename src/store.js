import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

export function segmentToText(seg) {
  if (!seg || typeof seg !== 'object') return '';
  const d = seg.data || {};
  switch (seg.type) {
    case 'text': return d.text ?? '';
    case 'face': return '[表情]';
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.name || d.qq || ''}`;
    case 'reply': return '[回复消息]';
    case 'forward': return '[合并转发]';
    case 'json': return '[卡片消息]';
    case 'dice': return '[骰子]';
    case 'poke': return '[戳一戳]';
    case 'redbag': return '[红包]';
    case 'shake': return '[窗口抖动]';
    default: return d.text ? String(d.text) : `[${seg.type}]`;
  }
}

export function extractText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.map(segmentToText).join('').trim();
}

export function localDate(tsMs) {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function hhmm(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtFull(d) {
  return `${localDate(d.getTime())} ${hhmm(Math.floor(d.getTime() / 1000))}`;
}

export class MessageStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.msgsDir = path.join(dataDir, 'messages');
    this.stateDir = path.join(dataDir, 'state');
    fs.mkdirSync(this.msgsDir, { recursive: true });
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.groupIds = new Set();
    this.groups = new Map();
    this.writtenIds = new Set();
    this.lastSeenTs = 0;
    this._loadLastSeen();
  }

  _lastSeenFile() {
    return path.join(this.stateDir, 'lastSeen.json');
  }

  _loadLastSeen() {
    try {
      const f = this._lastSeenFile();
      if (fs.existsSync(f)) {
        this.lastSeenTs = JSON.parse(fs.readFileSync(f, 'utf8')).lastSeenTs ?? 0;
      }
    } catch {
      this.lastSeenTs = 0;
    }
  }

  getLastSeenTs() {
    return this.lastSeenTs;
  }

  setLastSeenTs(ts) {
    this.lastSeenTs = Math.max(this.lastSeenTs, ts);
    try {
      fs.writeFileSync(this._lastSeenFile(), JSON.stringify({ lastSeenTs: this.lastSeenTs }));
    } catch {
      /* 忽略 */
    }
  }

  _group(groupId) {
    if (!this.groups.has(groupId)) {
      this.groups.set(groupId, { messages: new Map(), users: new Map(), lastSummaryAt: 0 });
    }
    return this.groups.get(groupId);
  }

  _fileFor(groupId, dateStr) {
    return path.join(this.msgsDir, String(groupId), `${dateStr}.jsonl`);
  }

  _stateFile(groupId) {
    return path.join(this.stateDir, `${groupId}.json`);
  }

  loadFromDisk(groupId, startTs = null, endTs = null) {
    const g = this._group(groupId);
    this.groupIds.add(groupId);

    const startDate = startTs ? localDate(startTs * 1000) : localDate(Date.now());
    const endDate = endTs ? localDate((endTs - 1) * 1000) : localDate(Date.now());

    let dateCursor = new Date(startDate + 'T00:00:00');
    const endDateObj = new Date(endDate + 'T00:00:00');
    let loaded = 0;

    while (dateCursor <= endDateObj) {
      const ds = localDate(dateCursor.getTime());
      const file = this._fileFor(groupId, ds);
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const seen = new Set();
        const uniqueLines = [];
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            if (!seen.has(rec.id)) {
              seen.add(rec.id);
              uniqueLines.push(line);
              g.messages.set(rec.id, rec);
              this.writtenIds.add(`${groupId}:${rec.id}`);
              this._learnUser(g, rec);
              loaded++;
            }
          } catch {
            /* 忽略损坏行 */
          }
        }
        if (uniqueLines.length !== lines.length) {
          fs.writeFileSync(file, uniqueLines.join('\n') + (uniqueLines.length ? '\n' : ''));
          log(`[store] 群 ${groupId} 文件 ${ds}.jsonl 已去重 (${lines.length} -> ${uniqueLines.length} 行)`);
        }
      }
      dateCursor.setDate(dateCursor.getDate() + 1);
    }

    if (loaded > 0) log(`[store] 群 ${groupId} 已从磁盘加载 ${loaded} 条消息 (${startDate} ~ ${endDate})`);

    const sf = this._stateFile(groupId);
    if (fs.existsSync(sf)) {
      try {
        g.lastSummaryAt = JSON.parse(fs.readFileSync(sf, 'utf8')).lastSummaryAt ?? 0;
      } catch {
        g.lastSummaryAt = 0;
      }
    }
    return g;
  }

  _learnUser(g, rec) {
    if (!rec.userId || !rec.name) return;
    const u = g.users.get(rec.userId);
    if (u && rec.card && u.card !== rec.card) {
      u.card = rec.card;
      u.name = rec.card || rec.name;
      return;
    }
    if (!u) g.users.set(rec.userId, { name: rec.name, card: rec.card || rec.name });
  }

  addMessage(event) {
    const g = this._group(event.group_id);
    this.groupIds.add(event.group_id);
    const text = extractText(event.message) || event.raw_message || '';
    if (!text) return null;
    const rec = {
      id: String(event.message_id),
      time: event.time ?? Math.floor(Date.now() / 1000),
      userId: event.user_id,
      name: event.sender?.card || event.sender?.nickname || '未知',
      card: event.sender?.card || '',
      text,
    };
    if (this.writtenIds.has(`${event.group_id}:${rec.id}`)) return null;
    g.messages.set(rec.id, rec);
    this.writtenIds.add(`${event.group_id}:${rec.id}`);
    this._learnUser(g, rec);
    this.setLastSeenTs(rec.time);
    const file = this._fileFor(event.group_id, localDate(rec.time * 1000));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return rec;
  }

  addHistoryMessage(groupId, msg) {
    const g = this._group(groupId);
    this.groupIds.add(groupId);
    const id = String(msg.message_id ?? msg.msgId ?? '');
    if (!id) return null;
    if (g.messages.has(id)) return null;

    const text = extractText(msg.message) || msg.raw_message || '';
    if (!text) return null;
    const rec = {
      id,
      time: msg.time ?? msg.msgTime ?? Math.floor(Date.now() / 1000),
      userId: msg.user_id ?? msg.sender?.user_id ?? 0,
      name: msg.sender?.card || msg.sender?.nickname || '未知',
      card: msg.sender?.card || '',
      text,
    };
    if (this.writtenIds.has(`${groupId}:${rec.id}`)) return null;
    g.messages.set(rec.id, rec);
    this.writtenIds.add(`${groupId}:${rec.id}`);
    this._learnUser(g, rec);
    const file = this._fileFor(groupId, localDate(rec.time * 1000));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return rec;
  }

  collectSince(groupId, sinceTs) {
    const g = this._group(groupId);
    const recs = [...g.messages.values()].filter((r) => r.time > sinceTs);
    recs.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return recs;
  }

  collectRange(groupId, startTs, endTs) {
    const g = this._group(groupId);
    const recs = [...g.messages.values()].filter((r) => r.time >= startTs && r.time < endTs);
    recs.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return recs;
  }

  getLastSummaryAt(groupId) {
    return this._group(groupId).lastSummaryAt;
  }

  setLastSummaryAt(groupId, ts) {
    const g = this._group(groupId);
    g.lastSummaryAt = ts;
    fs.writeFileSync(this._stateFile(groupId), JSON.stringify({ lastSummaryAt: ts }));
  }

  trackedGroupIds() {
    return [...this.groupIds];
  }
}

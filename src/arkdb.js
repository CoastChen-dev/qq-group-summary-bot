import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data', 'ark');

export class ArkDB {
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.characters = new Map(); // charId -> 基础信息
    this.handbooks = new Map();  // charId -> 档案
    this.aliasMap = new Map();   // 别名/名称 -> charId
    this.relics = new Map();     // 藏品名 -> 藏品信息
    this._loaded = false;
  }

  load() {
    if (this._loaded) return;
    const charFile = path.join(this.dataDir, 'character_table.json');
    const handbookFile = path.join(this.dataDir, 'handbook_info_table.json');

    if (fs.existsSync(charFile)) {
      try {
        const table = JSON.parse(fs.readFileSync(charFile, 'utf8'));
        const dict = table.characters || table;
        for (const [id, c] of Object.entries(dict)) {
          const name = c.name || '';
          this.characters.set(id, {
            id,
            name,
            rarity: c.rarity ?? -1,
            profession: c.profession || '',
            position: c.position || '',
            tags: c.tags || [],
            desc: (c.description || '').replace(/<[^>]+>/g, ''),
            nation: c.nation || '',
            team: c.team || '',
            groupId: c.groupId || '',
          });
          if (name) this.aliasMap.set(name, id);
          if (c.appellation) this.aliasMap.set(c.appellation, id);
        }
        log(`[arkdb] 已加载 ${this.characters.size} 个干员`);
      } catch (e) {
        log(`[arkdb] 干员表加载失败: ${e.message}`);
      }
    }

    if (fs.existsSync(handbookFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(handbookFile, 'utf8'));
        const dict = data.handbookDict || {};
        for (const [id, h] of Object.entries(dict)) {
          const profile = this._extractProfile(h);
          this.handbooks.set(id, profile);
          if (profile.name) this.aliasMap.set(profile.name, id);
        }
        log(`[arkdb] 已加载 ${this.handbooks.size} 份干员档案`);
      } catch (e) {
        log(`[arkdb] 档案表加载失败: ${e.message}`);
      }
    }

    // 肉鸽藏品表（集成战略藏品，含高卢银行支票等）
    const relicFile = path.join(this.dataDir, 'roguelike_topic_table.json');
    if (fs.existsSync(relicFile)) {
      try {
        const rl = JSON.parse(fs.readFileSync(relicFile, 'utf8'));
        const collectAll = (obj) => {
          const out = [];
          const walk = (o) => {
            if (!o || typeof o !== 'object') return;
            for (const v of Object.values(o)) {
              if (v && typeof v === 'object') {
                if (v.type === 'RELIC' && v.name) out.push(v);
                else walk(v);
              }
            }
          };
          walk(obj);
          return out;
        };
        const relics = collectAll(rl);
        for (const r of relics) {
          if (r.name) this.relics.set(r.name, r);
        }
        log(`[arkdb] 已加载 ${this.relics.size} 个肉鸽藏品`);
      } catch (e) {
        log(`[arkdb] 藏品表加载失败: ${e.message}`);
      }
    }

    this._loaded = true;
  }

  // 按藏品名查询
  findRelic(name) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (this.relics.has(n)) return this.relics.get(n);
    for (const [key, r] of this.relics) {
      if (key.length > 0 && key.includes(n)) return r;
    }
    return null;
  }

  // 判断文本是否提到某藏品（用于触发检索）
  containsRelicName(text) {
    if (!text) return false;
    this.load();
    const t = String(text);
    for (const key of this.relics.keys()) {
      if (key.length >= 2 && t.includes(key)) return true;
    }
    return false;
  }

  _extractProfile(handbook) {
    const text = handbook.storyTextAudio
      ?.map((s) => s.stories?.map((st) => st.storyText || '').join('\n'))
      .join('\n') || '';
    const get = (key) => {
      const m = text.match(new RegExp(`【${key}】([^\\n]*)`));
      return m ? m[1].trim() : '';
    };
    // infoName 可能为空或"Unknown"，优先用原文的【代号】
    let name = (handbook.infoName || '').trim();
    if (!name || name === 'Unknown') name = get('代号');
    return {
      charId: handbook.charID,
      name,
      gender: get('性别'),
      combatExp: get('战斗经验'),
      birthPlace: get('出身地'),
      birthday: get('生日'),
      race: get('种族'),
      height: get('身高'),
      infectionStatus: get('矿石病感染情况'),
      raw: text.slice(0, 3000),
    };
  }

  findByName(name) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (n.length === 0) return null;

    const id = this.aliasMap.get(n);
    if (id) return this.getById(id);

    // 模糊匹配：短名（≤2字）要求全词相等，避免"山""陈"等单字误配大量干员
    if (n.length <= 2) {
      return null;
    }
    for (const [key, cid] of this.aliasMap) {
      if (key.length > 0 && key !== n && (key.includes(n) || n.includes(key))) return this.getById(cid);
    }
    return null;
  }

  // 判断一段文本是否包含任何干员名/别名（≥2字），用于触发方舟检索
  containsOperatorName(text) {
    if (!text) return false;
    this.load();
    const t = String(text);
    for (const key of this.aliasMap.keys()) {
      if (key.length >= 2 && t.includes(key)) return true;
    }
    return false;
  }

  getById(id) {
    const base = this.characters.get(id);
    const profile = this.handbooks.get(id);
    if (!base && !profile) return null;
    const merged = { ...(base || {}), ...(profile || {}) };
    // name 优先用 character 表的（更可靠），profile 名仅作兜底
    if (base?.name) merged.name = base.name;
    return merged;
  }

  searchBirthday(keyword) {
    // 从关键词提取干员名
    const names = [...this.aliasMap.keys()];
    const hit = names.find((n) => keyword.includes(n));
    if (!hit) return null;
    const op = this.findByName(hit);
    if (!op) return null;
    return { name: op.name || hit, birthday: op.birthday || '' };
  }
}

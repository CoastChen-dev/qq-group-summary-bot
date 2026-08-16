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
    this.gachaPools = [];        // 真实卡池列表
    this._loaded = false;
  }

  // 清空内存缓存并重新加载（用于数据定期更新后）
  reload() {
    this.characters.clear();
    this.handbooks.clear();
    this.aliasMap.clear();
    this.relics.clear();
    this.gachaPools = [];
    this._loaded = false;
    this.load();
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
            notObtainable: c.isNotObtainable === true,
            spChar: c.isSpChar === true,
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

    // 真实卡池表
    const gachaFile = path.join(this.dataDir, 'gacha_table.json');
    if (fs.existsSync(gachaFile)) {
      try {
        const gt = JSON.parse(fs.readFileSync(gachaFile, 'utf8'));
        this.gachaPools = (gt.gachaPoolClient || []).filter((p) => p.gachaPoolId && p.gachaPoolName);
        log(`[arkdb] 已加载 ${this.gachaPools.length} 个卡池`);
      } catch (e) {
        log(`[arkdb] 卡池表加载失败: ${e.message}`);
      }
    }

    this._loaded = true;
  }

  // 按藏品名查询
  findRelic(name) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (n.length === 0) return null;
    if (this.relics.has(n)) return this.relics.get(n);
    // 模糊匹配：短词（≤2字）不模糊匹配，避免"高卢"误配"高卢小圆饼"
    if (n.length <= 2) return null;
    // 优先匹配包含关系：查询词包含在藏品名中（如"支票"→"高卢银行支票"）
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

  // ---- 语义模糊匹配（bigram Dice 系数，无外部依赖的轻量 embedding 替代）----
  _bigrams(str) {
    const s = String(str).replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }

  _similarity(a, b) {
    const A = this._bigrams(a);
    const B = this._bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
  }

  // 语义模糊匹配干员名（如"波登克"→"波登可"）
  findOperatorFuzzy(name, threshold = 0.38) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (n.length <= 1) return null;
    let best = null;
    let bestScore = threshold;
    for (const [key, cid] of this.aliasMap) {
      if (key.length <= 1) continue;
      if (Math.abs(key.length - n.length) > 4) continue;
      const score = this._similarity(n, key);
      if (score > bestScore) {
        bestScore = score;
        best = this.getById(cid);
      }
    }
    return best;
  }

  // 语义模糊匹配藏品名（如"高卢的支票本"→"高卢银行支票"）
  findRelicFuzzy(name, threshold = 0.38) {
    if (!name) return null;
    this.load();
    const n = String(name).trim();
    if (n.length <= 1) return null;
    let best = null;
    let bestScore = threshold;
    for (const [key, r] of this.relics) {
      if (key.length <= 1) continue;
      if (Math.abs(key.length - n.length) > 4) continue;
      const score = this._similarity(n, key);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best;
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

  // 今日过生日的干员列表
  todaysBirthdays(date = new Date()) {
    this.load();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const target = `${m}月${d}日`;
    const list = [];
    for (const [, profile] of this.handbooks) {
      if (profile.birthday && profile.birthday === target) {
        list.push(profile.name);
      }
    }
    return [...new Set(list)];
  }

  // 权重抽卡（模拟明日方舟出率：6星2% 5星8% 4星50% 3星40%）
  // 返回结构化数组 [{star, name, up}]，格式化交给调用方
  randomPull(n = 1) {
    this.load();
    const weights = { TIER_6: 0.02, TIER_5: 0.08, TIER_4: 0.5, TIER_3: 0.4 };
    const stars = { TIER_6: '★★★★★★', TIER_5: '★★★★★', TIER_4: '★★★★', TIER_3: '★★★' };
    const pool = [...this.characters.values()].filter((c) => c.name && weights[c.rarity] && this._isOperator(c) && !c.spChar);
    const pickOne = () => {
      let r = Math.random();
      for (const [tier, w] of Object.entries(weights)) {
        if (r < w) return { tier, star: stars[tier] };
        r -= w;
      }
      return { tier: 'TIER_3', star: stars.TIER_3 };
    };
    const results = [];
    for (let i = 0; i < n; i++) {
      const { tier, star } = pickOne();
      const candidates = pool.filter((c) => c.rarity === tier);
      const c = candidates[Math.floor(Math.random() * candidates.length)];
      results.push({ star, name: c ? c.name : '（未知）', up: false });
    }
    return results;
  }

  // ---- 真实卡池系统 ----

  // 是否为可抽取的真实干员（排除召唤物 TOKEN / 陷阱 TRAP / 不可获取的预备干员）
  _isOperator(c) {
    return ['MEDIC', 'WARRIOR', 'SPECIAL', 'SNIPER', 'SUPPORT', 'TANK', 'PIONEER', 'CASTER'].includes(c.profession)
      && !c.notObtainable;
  }

  // 当前开放的卡池
  currentGachaPools() {
    this.load();
    const now = Math.floor(Date.now() / 1000);
    return this.gachaPools.filter(
      (p) => (!p.openTime || p.openTime <= now) && (!p.endTime || p.endTime >= now)
    );
  }

  // 卡池概率提升干员（from dynMeta）
  poolRateUps(pool) {
    const up6 = [];
    const up5 = [];
    const d = pool?.dynMeta || {};
    if (d.main6RarityCharId) up6.push(d.main6RarityCharId);
    if (Array.isArray(d.rare5CharList)) up5.push(...d.rare5CharList);
    if (d.rarityPickCharDict) {
      for (const id of (d.rarityPickCharDict.TIER_6 || []).slice(0, 3)) up6.push(id);
      for (const id of (d.rarityPickCharDict.TIER_5 || []).slice(0, 3)) up5.push(id);
    }
    return {
      up6: [...new Set(up6)].filter((id) => this.characters.has(id)),
      up5: [...new Set(up5)].filter((id) => this.characters.has(id)),
    };
  }

  // 从指定卡池抽卡（真实出率：6★2% 5★8% 4★50% 3★40%；UP 干员占其星级概率的 50%）
  pullFromPool(pool, count = 10) {
    this.load();
    if (!pool) return this.randomPull(count);
    const { up6, up5 } = this.poolRateUps(pool);
    const upSet6 = new Set(up6);
    const upSet5 = new Set(up5);
    const stars = { TIER_6: '★★★★★★', TIER_5: '★★★★★', TIER_4: '★★★★', TIER_3: '★★★' };
    const byTier = { TIER_6: [], TIER_5: [], TIER_4: [], TIER_3: [] };
    for (const c of this.characters.values()) {
      if (!c.name || !byTier[c.rarity] || !this._isOperator(c)) continue;
      // 异格/联动限定干员（isSpChar）仅在其 UP 卡池中可抽取
      if (c.spChar && !upSet6.has(c.id) && !upSet5.has(c.id)) continue;
      byTier[c.rarity].push(c);
    }
    const pickTier = () => {
      const r = Math.random();
      if (r < 0.02) return 'TIER_6';
      if (r < 0.1) return 'TIER_5';
      if (r < 0.6) return 'TIER_4';
      return 'TIER_3';
    };
    const pickChar = (tier) => {
      let candidates = byTier[tier] || [];
      const upSet = tier === 'TIER_6' ? upSet6 : tier === 'TIER_5' ? upSet5 : new Set();
      if (upSet.size && Math.random() < 0.5) {
        const ups = candidates.filter((c) => upSet.has(c.id));
        if (ups.length) candidates = ups;
      } else {
        const nonUps = candidates.filter((c) => !upSet.has(c.id));
        if (nonUps.length) candidates = nonUps;
      }
      if (!candidates.length) candidates = byTier[tier] || [];
      const c = candidates[Math.floor(Math.random() * candidates.length)];
      return { star: stars[tier], name: c?.name || '未知', up: c ? upSet.has(c.id) : false };
    };
    const results = [];
    for (let i = 0; i < count; i++) {
      const tier = pickTier();
      const r = pickChar(tier);
      results.push({ star: r.star, name: r.name, up: r.up });
    }
    return results;
  }
}

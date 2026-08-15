import { log } from './logger.js';

const API_URL = 'https://prts.wiki/api.php';
const UA = 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)';

export function extractKeywords(question) {
  if (!question) return '';
  let text = String(question)
    .replace(/[？?。，,！!、；;：:（()）]/g, ' ')
    .replace(/(什么时候|啥时候|什么时候|是什么时候|是哪天|哪天|几号|几月|几月几日|几号生日)/g, ' ')
    .replace(/(谁|是什么|是什么人|是啥|哪一关|哪一章|怎么打|怎么过|怎么玩|在哪里|在哪|多少|怎么样|如何|能打|能过|能不能|有什么|干嘛|为何|为什么|求|推荐|介绍|说说|讲讲|知道吗|吗|呢|啊|吧|的|了|是|和|与|在|有|给|问|意思|含义|指|叫|俗称|别称|外号|梗|生日|资料|信息|简介|档案|设定|属性|数据|技能|强度|攻略|排行|评价|今天|哪个|什么|时候|干啥)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

// 明日方舟相关关键词（用于判断是否检索 PRTS.Wiki）
const ARK_KEYWORDS = [
  '明日方舟', '方舟', '阿米娅', '博士', '罗德岛', '干员', 'PRTS', 'prts',
  '龙门', '源石', '合成玉', '理智', '体力', '抽卡', '卡池', '寻访',
  '关卡', '剿灭', '危机合约', '集成战略', '肉鸽', '保全派驻', '生息演算',
  '基建', '线索', '精二', '专三', '专武', '潜能', '信赖', '技能',
  '能天使', '银灰', '艾雅法拉', '小火龙', '塞雷娅', '星熊', '拉普兰德',
  '德克萨斯', '推进之王', '斯卡蒂', '棘刺', '山', '水陈', '玛恩纳',
  '史尔特尔', '42', '泥岩', '煌', '夜莺', '白面鸮', '赛诺斯',
  '凯尔希', '陈', '诗怀雅', '凛冬', '守林人', '梅', '桃金娘',
  '普瑞塞斯', '特蕾西娅', '博士', '源石病', '矿石病', '感染者', '整合运动',
  '爱国者', '霜星', '塔露拉', '迷迭香', 'W', '凯尔西', '阿米娅',
  '先锋', '近卫', '重装', '狙击', '术士', '医疗', '辅助', '特种',
  '部署', '费用', '攻速', '攻击力', '防御', '法抗', '模组', '专精',
];

const STAGE_PATTERN = /(^|[^A-Za-z0-9])([A-Za-z]?-?[0-9]+-[0-9]+|[A-Za-z]{2,3}-?[0-9]{1,3})([^A-Za-z0-9]|$)/i;

export function isArknightsRelated(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  for (const kw of ARK_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) return true;
  }
  if (STAGE_PATTERN.test(text)) return true;
  return false;
}

export class WikiRetriever {
  constructor(cfg = {}) {
    this.enabled = cfg.wikiEnabled !== false;
    this.apiUrl = cfg.wikiApiUrl || API_URL;
    this.maxResults = cfg.wikiMaxResults ?? 5;
    this.maxCharPerPage = cfg.wikiMaxCharPerPage ?? 4000;
    this.topK = cfg.wikiTopK ?? 3;
    this.snippets = new Map();
    this.lastQuery = null;
    this._minInterval = cfg.wikiMinInterval ?? 2000;
    this._cooldownMs = cfg.wikiCooldownMs ?? 10000;
    this._lastRequestAt = 0;
    this._antiBotUntil = 0;
    this._consecutiveFail = 0;
  }

  async _waitForSlot() {
    const now = Date.now();
    const waitUntil = Math.max(this._lastRequestAt + this._minInterval, this._antiBotUntil);
    if (now < waitUntil) {
      await new Promise((r) => setTimeout(r, waitUntil - now));
    }
    this._lastRequestAt = Date.now();
  }

  async _get(params, retries = 3) {
    const full = { format: 'json', ...params };
    const qs = Object.entries(full)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.apiUrl}?${qs}`;

    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      await this._waitForSlot();
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        });
        const text = await resp.text();
        const trimmed = text.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          this._consecutiveFail = 0;
          return JSON.parse(text);
        }
        this._consecutiveFail++;
        if (this._consecutiveFail >= 2) {
          this._antiBotUntil = Date.now() + this._cooldownMs;
          log(`[wiki] 连续反爬，进入 ${this._cooldownMs / 1000}s 冷却`);
        }
        lastErr = new Error(`Wiki 返回 HTML(可能是反爬，第${attempt}次)`);
      } catch (e) {
        this._consecutiveFail++;
        lastErr = e;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500));
    }
    throw lastErr || new Error('Wiki 请求失败');
  }

  async search(title) {
    if (!this.enabled || !title) return [];
    this.lastQuery = title;
    const query = extractKeywords(title) || title;
    try {
      const data = await this._get({
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: String(this.maxResults),
        srprop: 'snippet|wordcount|size',
      });
      const results = (data?.query?.search || []).map((r) => ({
        title: r.title,
        snippet: (r.snippet || '').replace(/<[^>]+>/g, ''),
        size: r.size ?? 0,
        wordcount: r.wordcount ?? 0,
      }));
      log(`[wiki] 搜索 "${title}" → ${results.length} 条结果`);
      return results;
    } catch (e) {
      log(`[wiki] 搜索失败: ${e.message}`);
      return [];
    }
  }

  async getPageContent(title) {
    try {
      const data = await this._get({
        action: 'parse',
        page: title,
        prop: 'wikitext',
        formatversion: '2',
      });
      const wikitext = data?.parse?.wikitext || '';
      const cleaned = this._cleanWikitext(wikitext);
      return cleaned.slice(0, this.maxCharPerPage);
    } catch (e) {
      log(`[wiki] 拉取页面 "${title}" 失败: ${e.message}`);
      return '';
    }
  }

  _cleanWikitext(text) {
    if (!text) return '';
    let out = text;
    out = out.replace(/<ref[\s\S]*?<\/ref>/g, '');
    out = out.replace(/<[^>]+>/g, '');
    out = out.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
    out = out.replace(/\{\{[^}]*\}\}/g, '');
    out = out.replace(/'''|''/g, '');
    out = out.replace(/\n{3,}/g, '\n\n');
    out = out.replace(/[ \t]{2,}/g, ' ');
    return out.trim();
  }

  async retrieve(question) {
    if (!this.enabled) return { context: '', sources: [] };

    const hits = await this.search(question);
    if (hits.length === 0) return { context: '', sources: [] };

    const pages = [];
    let maxSize = 0;
    for (const hit of hits.slice(0, this.topK)) {
      const content = await this.getPageContent(hit.title);
      if (content) {
        pages.push({ title: hit.title, content, size: hit.size || 0, wordcount: hit.wordcount || 0 });
        maxSize = Math.max(maxSize, hit.size || 0);
      }
    }

    const context = pages
      .map((p) => `【${p.title}】\n${p.content}`)
      .join('\n\n---\n\n')
      .slice(0, this.topK * this.maxCharPerPage);

    return { context, sources: pages.map((p) => p.title), scoreSize: maxSize };
  }
}

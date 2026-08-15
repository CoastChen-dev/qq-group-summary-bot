import { log } from './logger.js';
import { extractKeywords } from './wiki.js';

const API_URL = 'https://zh.moegirl.org.cn/api.php';
const SITE_URL = 'https://zh.moegirl.org.cn';
const UA = 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 与明日方舟社区梗/黑话相关的萌娘百科主词条（梗/物品/世界观可能收录在这些页面中）
const ARK_LINGO_PAGES = [
  '明日方舟/梗',
  '明日方舟',
  '魔法Zc目录',
  '龙哥哥今天又鸽了',
  '明日方舟UP主',
  // 世界观/地区/阵营（含大量物品、货币、梗的记录）
  '高卢(明日方舟)',
  '龙门(明日方舟)',
  '维多利亚(明日方舟)',
  '乌萨斯(明日方舟)',
  '哥伦比亚(明日方舟)',
  '莱塔尼亚(明日方舟)',
  '谢拉格(明日方舟)',
  '炎国(明日方舟)',
  '卡西米尔(明日方舟)',
  '罗德岛(明日方舟)',
  '整合运动(明日方舟)',
  '明日方舟/世界观',
];

export class MoegirlRetriever {
  constructor(cfg = {}) {
    this.enabled = cfg.moegirlEnabled !== false;
    this.maxCharPerPage = cfg.moegirlMaxCharPerPage ?? 5000;
    this.topK = cfg.moegirlTopK ?? 2;
    this._minInterval = cfg.moegirlMinInterval ?? 1500;
    this._lastRequestAt = 0;
  }

  async _wait() {
    const now = Date.now();
    if (now < this._lastRequestAt + this._minInterval) {
      await new Promise((r) => setTimeout(r, this._lastRequestAt + this._minInterval - now));
    }
    this._lastRequestAt = Date.now();
  }

  async searchOpensearch(keyword, limit = 5) {
    const url = `${API_URL}?action=opensearch&search=${encodeURIComponent(keyword)}&format=json&limit=${limit}`;
    await this._wait();
    const resp = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const data = await resp.json();
    // opensearch 返回 [query, titles[], desc[], urls[]]
    return (data?.[1] || []).map((title, i) => ({ title, url: data?.[3]?.[i] }));
  }

  // 生成关键词的匹配变体：325 → ["325", "3-25", "三二五", "3 2 5"]
  _keywordVariants(keyword) {
    const variants = new Set([String(keyword).trim()]);
    const t = String(keyword).trim();
    // 从混合文本中提取纯数字（如 "325 意思" → "325"）
    const pureNum = t.match(/\d+/);
    if (pureNum) variants.add(pureNum[0]);
    const numMatch = t.match(/^(\d+)$/);
    if (numMatch) {
      const digits = numMatch[1];
      variants.add(digits.split('').join('-'));
      variants.add(digits.split('').join(' '));
      const cn = digits.split('').map((d) => '零一二三四五六七八九'[Number(d)]).join('');
      variants.add(cn);
    }
    return [...variants];
  }

  async getPageHtml(title) {
    await this._wait();
    const url = `${SITE_URL}/${encodeURIComponent(title)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
    if (!resp.ok) throw new Error(`Moegirl ${resp.status}`);
    return resp.text();
  }

  extractBody(html) {
    let body = html;
    // 优先匹配正文容器（MediaWiki 常见结构）
    const patterns = [
      /<div class="mw-parser-output">([\s\S]*?)<\/div>\s*<\/div>/,
      /<div id="mw-content-text"[^>]*>([\s\S]*?)<div class="printfooter"|/,
      /<div class="mw-body-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/,
      /<div id="bodyContent"[^>]*>([\s\S]*?)<div class="printfooter"|/,
    ];
    for (const p of patterns) {
      const m = body.match(p);
      if (m && m[1] && m[1].length > 500) {
        body = m[1];
        break;
      }
    }
    // 若上面都没匹配到，尝试截取 mw-content-text 之后、页面底部之前的内容
    if (body.length === html.length) {
      const start = body.indexOf('id="mw-content-text"');
      if (start > 0) {
        const cut = body.indexOf('id="catlinks"', start);
        const end = cut > start ? cut : Math.min(start + 200000, body.length);
        body = body.slice(start, end);
      }
    }
    body = body
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return body;
  }

  _isRelevantHit(title, keyword) {
    const t = String(title).toLowerCase();
    const kw = String(keyword).toLowerCase();
    if (t.includes(kw)) return true;
    // 关键词是短数字/代号时，允许命中方舟相关词条（含明日方舟标记）
    if (/^[0-9a-z\-]+$/.test(kw) && /明日方舟|方舟|罗德岛|prts|干员/.test(t)) return true;
    return false;
  }

  async retrieve(keyword) {
    if (!this.enabled || !keyword) return { context: '', sources: [] };

    const pages = [];
    const seen = new Set();
    const core = extractKeywords(keyword) || String(keyword).trim();
    const variants = this._keywordVariants(core);

    // 1. 尝试直接搜关键词对应词条（用核心词，如"波登可生日"→"波登可"）
    try {
      const hits = await this.searchOpensearch(core);
      for (const hit of hits) {
        if (seen.has(hit.title)) continue;
        seen.add(hit.title);
        if (pages.length >= this.topK) break;
        if (!this._isRelevantHit(hit.title, core)) continue;
        try {
          const html = await this.getPageHtml(hit.title);
          const body = this.extractBody(html);
          if (body.length > 200) pages.push({ title: hit.title, content: body.slice(0, this.maxCharPerPage) });
        } catch {
          /* 跳过抓取失败 */
        }
      }
    } catch (e) {
      log(`[moegirl] 搜索失败: ${e.message}`);
    }

    // 2. 若不足，从方舟梗主页面补充检索相关段落
    if (pages.length < this.topK) {
      // 先在所有兜底页面中寻找关键词命中（优先级最高）
      let hitPage = null;
      for (const page of ARK_LINGO_PAGES) {
        if (seen.has(page)) continue;
        seen.add(page);
        try {
          const html = await this.getPageHtml(page);
          const body = this.extractBody(html);
          for (const v of variants) {
            const kwIdx = body.indexOf(v);
            if (kwIdx > 0) {
              const start = Math.max(0, kwIdx - 200);
              hitPage = { title: page, content: body.slice(start, start + this.maxCharPerPage) };
              log(`[moegirl] 在 "${page}" 中定位到 "${v}"`);
              break;
            }
          }
          if (hitPage) break;
        } catch {
          /* 跳过 */
        }
      }
      if (hitPage) {
        pages.unshift(hitPage);
      }
    }

    const context = pages.map((p) => `【${p.title}】\n${p.content}`).join('\n\n---\n\n');
    log(`[moegirl] 关键词 "${keyword}" → ${pages.length} 个词条`);
    const totalSize = pages.reduce((acc, p) => acc + (p.content?.length || 0), 0);
    return { context, sources: pages.map((p) => p.title), scoreSize: totalSize };
  }
}

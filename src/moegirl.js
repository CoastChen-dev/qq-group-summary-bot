import { log } from './logger.js';

const API_URL = 'https://zh.moegirl.org.cn/api.php';
const SITE_URL = 'https://zh.moegirl.org.cn';
const UA = 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 与明日方舟社区梗/黑话相关的萌娘百科主词条
const ARK_LINGO_PAGES = ['明日方舟/梗', '明日方舟'];

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

  async getPageHtml(title) {
    await this._wait();
    const url = `${SITE_URL}/${encodeURIComponent(title)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
    if (!resp.ok) throw new Error(`Moegirl ${resp.status}`);
    return resp.text();
  }

  extractBody(html) {
    let body = html;
    const m = body.match(/<div class="mw-parser-output">([\s\S]*?)<\/div>\s*<\/div>/);
    if (m) body = m[1];
    body = body
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return body;
  }

  async retrieve(keyword) {
    if (!this.enabled || !keyword) return { context: '', sources: [] };

    const pages = [];
    const seen = new Set();

    // 1. 尝试直接搜关键词对应词条
    try {
      const hits = await this.searchOpensearch(keyword);
      for (const hit of hits) {
        if (seen.has(hit.title)) continue;
        seen.add(hit.title);
        if (pages.length >= this.topK) break;
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
      for (const page of ARK_LINGO_PAGES) {
        if (seen.has(page) || pages.length >= this.topK) break;
        seen.add(page);
        try {
          const html = await this.getPageHtml(page);
          const body = this.extractBody(html);
          if (body) {
            // 尝试定位关键词附近的段落
            const kwIdx = body.indexOf(keyword);
            let content = body;
            if (kwIdx > 0) {
              const start = Math.max(0, kwIdx - 200);
              content = body.slice(start, start + this.maxCharPerPage);
            } else {
              content = body.slice(0, this.maxCharPerPage);
            }
            pages.push({ title: page, content });
          }
        } catch {
          /* 跳过 */
        }
      }
    }

    const context = pages.map((p) => `【${p.title}】\n${p.content}`).join('\n\n---\n\n');
    log(`[moegirl] 关键词 "${keyword}" → ${pages.length} 个词条`);
    return { context, sources: pages.map((p) => p.title) };
  }
}

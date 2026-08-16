import { log } from './logger.js';
import { extractKeywords } from './wiki.js';

const API_URL = 'https://zh.wikipedia.org/w/api.php';
const UA = 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)';

export class WikipediaRetriever {
  constructor(cfg = {}) {
    this.enabled = cfg.wikipediaEnabled === true;
    this.apiUrl = cfg.wikipediaApiUrl || API_URL;
    this.maxCharPerPage = cfg.wikipediaMaxCharPerPage ?? 2000;
    this.topK = cfg.wikipediaTopK ?? 2;
    this._minInterval = cfg.wikipediaMinInterval ?? 1500;
    this._lastRequestAt = 0;
  }

  async _wait() {
    const now = Date.now();
    if (now < this._lastRequestAt + this._minInterval) {
      await new Promise((r) => setTimeout(r, this._lastRequestAt + this._minInterval - now));
    }
    this._lastRequestAt = Date.now();
  }

  async _get(params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    await this._wait();
    const resp = await fetch(`${this.apiUrl}?${qs}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Wikipedia ${resp.status}`);
    return resp.json();
  }

  async search(keyword) {
    const data = await this._get({
      action: 'query',
      list: 'search',
      srsearch: keyword,
      srlimit: String(this.topK + 2),
      format: 'json',
    });
    return (data?.query?.search || []).map((r) => r.title);
  }

  async getExtract(title) {
    const data = await this._get({
      action: 'query',
      prop: 'extracts',
      exintro: '1',
      explaintext: '1',
      titles: title,
      format: 'json',
    });
    const pages = data?.query?.pages || {};
    return Object.values(pages)[0]?.extract || '';
  }

  async retrieve(question) {
    if (!this.enabled) return { context: '', sources: [] };
    const core = extractKeywords(question) || String(question).trim();
    if (!core) return { context: '', sources: [] };

    try {
      const titles = await this.search(core);
      const pages = [];
      for (const title of titles.slice(0, this.topK)) {
        const extract = await this.getExtract(title);
        if (extract && extract.length > 50) {
          pages.push({ title, content: extract.slice(0, this.maxCharPerPage) });
        }
      }
      const context = pages.map((p) => `【${p.title}】\n${p.content}`).join('\n\n---\n\n');
      log(`[wikipedia] 关键词 "${core}" → ${pages.length} 个词条`);
      return { context, sources: pages.map((p) => p.title) };
    } catch (e) {
      log(`[wikipedia] 检索失败: ${e.message}`);
      return { context: '', sources: [] };
    }
  }
}

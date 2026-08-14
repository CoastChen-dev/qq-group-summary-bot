import { log } from './logger.js';

const API_URL = 'https://prts.wiki/api.php';
const UA = 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)';

export class WikiRetriever {
  constructor(cfg = {}) {
    this.enabled = cfg.wikiEnabled !== false;
    this.apiUrl = cfg.wikiApiUrl || API_URL;
    this.maxResults = cfg.wikiMaxResults ?? 5;
    this.maxCharPerPage = cfg.wikiMaxCharPerPage ?? 4000;
    this.topK = cfg.wikiTopK ?? 3;
    this.snippets = new Map();
    this.lastQuery = null;
  }

  async _get(params, retries = 3) {
    const full = { format: 'json', ...params };
    const qs = Object.entries(full)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.apiUrl}?${qs}`;

    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        });
        const text = await resp.text();
        const trimmed = text.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          return JSON.parse(text);
        }
        // 反爬 HTML 页面
        lastErr = new Error(`Wiki 返回 HTML(可能是反爬，第${attempt}次)`);
      } catch (e) {
        lastErr = e;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500));
    }
    throw lastErr || new Error('Wiki 请求失败');
  }

  async search(title) {
    if (!this.enabled || !title) return [];
    this.lastQuery = title;
    try {
      const data = await this._get({
        action: 'query',
        list: 'search',
        srsearch: title,
        srlimit: String(this.maxResults),
        srprop: 'snippet',
      });
      const results = (data?.query?.search || []).map((r) => ({
        title: r.title,
        snippet: (r.snippet || '').replace(/<[^>]+>/g, ''),
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
    for (const hit of hits.slice(0, this.topK)) {
      const content = await this.getPageContent(hit.title);
      if (content) pages.push({ title: hit.title, content });
    }

    const context = pages
      .map((p) => `【${p.title}】\n${p.content}`)
      .join('\n\n---\n\n')
      .slice(0, this.topK * this.maxCharPerPage);

    return { context, sources: pages.map((p) => p.title) };
  }
}

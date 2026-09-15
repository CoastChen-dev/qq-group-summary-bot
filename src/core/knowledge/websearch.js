/*
 * 联网搜索检索器（国内搜索 API，可选）：为 ChatBrain 的通用检索提供「模型联网搜索」替代源，
 * 启用后取代萌娘百科/维基百科成为通用知识来源（减少对百科站的依赖），与三个 Wiki 检索器同形
 * 输出 {context, sources, scoreSize}，由 ChatBrain 统一并行调度与评分排序。
 *
 * 支持 provider（config.webSearch.provider）：
 *   - zhipu：智谱 Web Search API（https://open.bigmodel.cn/api/paas/v4/web_search，0.01 元/次起）
 *   - bocha：博查 Web Search API（https://api.bochaai.com/v1/web-search）
 * 启用条件：config.webSearch.enabled !== false 且 apiKey 非空（缺 key 自动禁用，回落百科源）。
 * 依赖：core/platform/http.js fetchRetry、logger；实例化点：core/runtime.js 装配为共享单例。
 * 读写数据：只读网络；失败/超时返回空结果（不抛错，ChatBrain 按空处理）。
 */
import { log } from '../platform/logger.js';
import { fetchRetry } from '../platform/http.js';

const PROVIDERS = {
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/web_search',
    body: (query, count) => ({ search_engine: 'search_std', search_query: query, count }),
    parse: (data, count) => (data.search_result || []).slice(0, count).map((r) => ({
      title: r.title || r.media || '',
      url: r.link || '',
      snippet: String(r.content || ''),
    })),
  },
  bocha: {
    url: 'https://api.bochaai.com/v1/web-search',
    body: (query, count) => ({ query, summary: true, count }),
    parse: (data, count) => (data?.data?.webPages?.value || []).slice(0, count).map((r) => ({
      title: r.name || '',
      url: r.url || '',
      snippet: String(r.summary || r.snippet || ''),
    })),
  },
};

/**
 * 联网搜索检索器：query → 搜索 API → 结构化结果 → 【联网搜索】上下文段。
 */
export class WebSearchRetriever {
  /**
   * @param {Object} [cfg={}] - config.webSearch 子集
   * @param {boolean} [cfg.enabled=true] - 开关（!== false 视为开）；apiKey 为空时仍自动禁用
   * @param {string} [cfg.provider='zhipu'] - 搜索平台（zhipu | bocha）
   * @param {string} [cfg.apiKey=''] - 平台 API Key（必填才启用）
   * @param {number} [cfg.count=5] - 结果条数（1–10）
   * @param {number} [cfg.timeoutMs=5000] - 单次搜索超时（毫秒）
   */
  constructor(cfg = {}) {
    this.provider = PROVIDERS[cfg.provider] ? cfg.provider : 'zhipu';
    this.apiKey = cfg.apiKey || '';
    this.enabled = cfg.enabled !== false && !!this.apiKey;
    this.count = Math.min(Math.max(cfg.count ?? 5, 1), 10);
    this.timeoutMs = cfg.timeoutMs ?? 5000;
  }

  /**
   * 执行一次联网搜索。
   * @param {string} query - 搜索词（通常为群友问题原文）
   * @returns {Promise<{context: string, sources: string[], scoreSize: number}>} 与 Wiki 检索器同形；
   *   未启用/无结果/请求失败时 context 为空串
   * 副作用：一次 HTTP 请求（经 fetchRetry：timeoutMs 超时、1 次重试）
   */
  async retrieve(query) {
    if (!this.enabled || !query) return { context: '', sources: [], scoreSize: 0 };
    const p = PROVIDERS[this.provider];
    try {
      const resp = await fetchRetry(p.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(p.body(String(query).slice(0, 200), this.count)),
      }, { timeoutMs: this.timeoutMs, retries: 1, retryDelayMs: 500 });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const results = p.parse(data, this.count)
        .map((r) => ({ ...r, snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 200) }))
        .filter((r) => r.title && r.snippet);
      if (!results.length) return { context: '', sources: [], scoreSize: 0 };
      const context = `【联网搜索】\n${results.map((r, i) => `${i + 1}. ${r.title}：${r.snippet}${r.url ? `（${r.url}）` : ''}`).join('\n')}`;
      log(`[websearch] ${this.provider} 搜索「${String(query).slice(0, 20)}」命中 ${results.length} 条`);
      return { context, sources: results.map((r) => r.title), scoreSize: context.length };
    } catch (e) {
      log(`[websearch] 搜索失败（${this.provider}）: ${e.message}`);
      return { context: '', sources: [], scoreSize: 0 };
    }
  }
}

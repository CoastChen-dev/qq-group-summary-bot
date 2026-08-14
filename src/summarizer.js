import { hhmm } from './store.js';
import { log } from './logger.js';

export class Summarizer {
  constructor(cfg = {}) {
    this.apiKey = cfg.apiKey || process.env.LLM_API_KEY || '';
    this.baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = cfg.model || 'gpt-3.5-turbo';
    this.maxMessages = cfg.maxMessages || 2000;
    this.maxTokens = cfg.maxTokens || 1024;
  }

  async summarize(groupId, recs, spanText, purpose = 'manual') {
    if (!recs.length) return null;

    const lines = recs.map((r) => `[${hhmm(r.time)}] ${r.name}: ${r.text}`);
    const trimmed = lines.slice(-this.maxMessages).join('\n');

    const role = purpose === 'daily'
      ? '你是一天群聊的记录官，负责为群主产出每日群聊日报。'
      : '你是专业的群聊分析助手。';

    const prompt = [
      role,
      '',
      `消息数量：${recs.length} 条`,
      '',
      purpose === 'daily'
        ? '请用简洁的中文生成这份群的"昨日日报"概括，使用 markdown 格式：'
        : '请用简洁的中文生成一份群聊概括，使用 markdown 格式：',
      '1. 主要话题：按讨论热度列出 2-5 个话题及简述',
      '2. 关键信息：重要通知、结论、决策等（如无则写"无"）',
      '3. 待办或提醒：群里提到的待办事项、需要某人注意的事情（如无则写"无"）',
      '4. 活跃概况：一句话点评整体讨论氛围',
      '',
      '要求：',
      '- 严格基于聊天记录内容，不要编造或猜测记录之外的信息',
      '- 不要输出群号、时间范围等元信息',
      '- 严禁输出任何涉及个人隐私、色情、暴力、违法或不当的内容；如聊天中有此类内容，一律不提及',
      '- 每条要点控制在 1-2 行',
      `- 总长度控制在约 ${purpose === 'daily' ? 500 : 300} 字以内`,
      '',
      '聊天记录：',
      trimmed,
    ].join('\n');

    log(`[summarizer] 正在调用 ${this.model} 概括群 ${groupId}...`);

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: '你是一个严谨、简洁的群聊分析助手。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: this.maxTokens,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM API 错误 ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM 返回内容为空');
    return content;
  }
}

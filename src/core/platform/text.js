/**
 * 出站文本切分：QQ 单条群消息有长度上限（文本约 4KB 量级），超长会被 NapCat/QQ 拒发
 * （retcode 1200）或截断——LLM 回复（尤其 thinkingMaxTokens=8192 的深度思考模式）与
 * 概括类文案都可能超限，故发送前统一切分（2026-10）。
 *
 * 策略：按 UTF-8 字节预算（默认 3500B，留出转义余量）切块；尽量在换行/句末断开，不把
 * 一句话劈开；块间只裁掉断点处的空白，正文内容不丢。
 *
 * 对外导出：splitMessage、MAX_MESSAGE_BYTES。纯函数，无状态。
 */
export const MAX_MESSAGE_BYTES = 3500;

// 断点优先级：换行 > 中文句末标点 > 英文句号+空格（只在切点前 60% 之后找，避免碎块）
const BREAK_SEPS = ['\n', '。', '！', '？', '；', '. '];

/**
 * 把一段文本切成若干条消息，每块 UTF-8 字节数 ≤ maxBytes。
 *
 * @param {string} text - 原文（null/undefined 视为空）
 * @param {number} [maxBytes=3500] - 单块字节预算（须 ≥ 4，容纳一个码点）
 * @returns {string[]} 切好的块（空文本返回 []；不改变顺序、不丢正文）
 */
export function splitMessage(text, maxBytes = MAX_MESSAGE_BYTES) {
  const s = String(text ?? '');
  if (!s) return [];
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return [s];

  const chunks = [];
  let rest = s;
  while (rest) {
    if (Buffer.byteLength(rest, 'utf8') <= maxBytes) {
      chunks.push(rest);
      break;
    }
    // 按字节预算取切点（按码点遍历，不会把 emoji/汉字切一半）
    let cut = 0;
    let bytes = 0;
    for (const ch of rest) {
      const b = Buffer.byteLength(ch, 'utf8');
      if (bytes + b > maxBytes) break;
      bytes += b;
      cut += ch.length;
    }
    if (cut === 0) cut = 1; // 兜底：预算小于一个码点

    // 回退到最近的断点（不早于预算的 60%，否则宁可按字节切）
    const floor = Math.floor(cut * 0.6);
    let breakAt = -1;
    for (const sep of BREAK_SEPS) {
      const i = rest.lastIndexOf(sep, cut - 1);
      if (i > breakAt) breakAt = i;
    }
    if (breakAt >= floor) cut = breakAt + 1;

    const piece = rest.slice(0, cut).trimEnd();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  return chunks;
}

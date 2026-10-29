/*
 * 敏感内容过滤模块：识别群消息中的个人信息与硬敏感词，供消息入库与日报统计前剔除敏感消息、脱敏保留其余消息。
 *
 * 三档口径（2026-10 重写；此前「密码」「诈骗」「自杀」「AV」等词直接整条剔除，实测一天误删
 * 55/1981 条——「密码学」「流密码」「防诈骗」全被当成敏感内容，JAVA 还会命中 AV）：
 *   ① HARD_KEYWORDS：真违规硬词，命中即整条剔除；
 *   ② PRIVACY_CONTEXT：隐私词只在「自述具体值」或「索取/递交」句式下才判敏感
 *      （密码学、密码忘了、验证码收不到、防诈骗 都不再命中）；
 *   ③ PRIVACY_PATTERNS：手机号/邮箱/身份证/银行卡/地址/IP 等具体值正则（保持不变）。
 * 出站（isSensitiveOutbound）与入站同口径，避免模型把隐私值说出去；两者保留独立入口，便于将来差异化。
 *
 * 导出：isSensitive / isSensitiveOutbound / sanitizeText / filterMessages（均无副作用纯函数）。
 * 依赖：无；由 core/runtime.js import filterMessages（经配置开关包装后注入 summary/report 插件），
 * isSensitive/sanitizeText 供本模块与 plugins/chat.js 使用。
 * 数据：不读写任何文件；匹配模式、词表与脱敏占位符均为本文件私有常量。
 */

// 模块私有：隐私信息正则集（带 g 标志，调用前需重置 lastIndex）；命中即判为敏感，并被 sanitizeText 替换为占位符
const PRIVACY_PATTERNS = [
  // 大陆手机号：1[3-9] 开头 11 位
  /(?<![0-9])1[3-9]\d{9}(?![0-9])/g,
  // 邮箱
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // 身份证号 18 位
  /\b\d{17}[\dXx]\b/g,
  // 银行卡号（13-19 位）
  /\b(?:\d{4}[- ]?){3,4}\d{1,3}\b/g,
  // 地址：行政区划词（省可选）+ 市/区/县 + 具体路名/大道（紧邻组合，避免单字误伤）
  /(?:[\u4e00-\u9fff]{1,6}?(?:省|自治区|特别行政区))?[\u4e00-\u9fff]{1,8}?(?:市|自治州|区|县|镇|乡|街道)[\u4e00-\u9fff]{1,10}?(?:路|街|大道|巷|胡同|弄)/g,
  // IP 地址
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
];

// 模块私有：真违规硬词（命中即整条剔除；话题词如「诈骗/自杀/自拍」不在此列，由 summarizer 的
// 输出约束兜底）。注意不要放 "AV" 这类会命中 JAVA/AVX 的短词。
const HARD_KEYWORDS = [
  '裸照', '裸聊', '色情', '黄色视频', '黄片', 'a片',
  '约炮', '卖淫', '嫖娼', '援助交际', '包养',
  '毒品', '冰毒', '海洛因', '大麻', '摇头丸',
  '枪支', '弹药', '爆炸物', '自制炸弹',
  '赌博', '博彩', '赌球', '六合彩',
];

// 模块私有：隐私词的上下文句式（2026-10：不再「出现关键词就整条剔除」）。
// ① 自述具体值：我的密码是 abc123 / 密码：123456 / 身份证号是 110...
//    —— 分隔符后必须跟 2+ 个非空白字符，且排除「是什么/是啥/是多少/是谁/是哪/是么/不是/忘了」这类提问
// ② 索取/递交：把验证码发我 / 发一下你的手机号 / 私聊我密码
const PRIVACY_CONTEXT = [
  /(?:我的|我|本人)?[^，。！？\s]{0,4}(?:身份证号?|银行卡号?|手机号|电话号码|住址|家庭住址|账号密码|密码|验证码)\s*(?:是|为|：|:|=)\s*(?!(?:什么|啥|多少|谁|哪|么|不是|忘了|忘记))[^\s，。！？]{2,}/,
  /(?:(?:发|给|报|填|输|告诉|提供|私聊)[^，。！？]{0,6}(?:身份证号?|银行卡号?|手机号|电话号码|住址|家庭住址|账号密码|密码|验证码))|(?:(?:身份证号?|银行卡号?|手机号|电话号码|住址|家庭住址|账号密码|密码|验证码)[^，。！？]{0,4}(?:发我|给我|发一下|报一下|私聊我))/,
];

// 模块私有：脱敏时的替换占位符（仅替换隐私模式匹配段，不替换关键词本身）
const PLACEHOLDER = '[内容已过滤]';

/**
 * 判断文本是否命中硬敏感词、隐私自述/索取句式或隐私模式（手机号/邮箱/身份证/银行卡/地址/IP）。
 * @param {string} text - 待检测文本
 * @returns {boolean} 命中任一规则返回 true；空文本或未命中返回 false
 */
export function isSensitive(text) {
  if (!text) return false;
  for (const kw of HARD_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  for (const re of PRIVACY_CONTEXT) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  for (const re of PRIVACY_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * 出站敏感判定（2026-10）：与入站同口径（硬词 + 隐私自述/索取 + 隐私模式）。
 * 保留独立入口：将来若要给「模型回复」更严/更宽的规则，不必改入站过滤。
 * @param {string} text - 待检测的模型回复
 * @returns {boolean} 命中返回 true（调用方替换为安全文案）
 */
export function isSensitiveOutbound(text) {
  return isSensitive(text);
}

/**
 * 将文本中所有隐私模式匹配段（手机号/邮箱/身份证/银行卡/地址/IP）替换为占位符。
 * @param {string} text - 待脱敏文本
 * @returns {string} 脱敏后的文本；空文本（含 null/undefined）原样返回
 */
export function sanitizeText(text) {
  if (!text) return text;
  let out = text;
  for (const re of PRIVACY_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, PLACEHOLDER);
  }
  return out;
}

/**
 * 按条分流消息数组：敏感消息整体剔除，其余消息做隐私脱敏后保留（仅改 text 字段，其余字段透传）。
 * @param {Object[]} recs - 消息记录数组，每条需含 text 字段
 * @returns {{kept: Object[], filtered: Object[]}} kept 为脱敏后的保留记录；filtered 为命中敏感内容被剔除的原始记录
 */
export function filterMessages(recs) {
  const kept = [];
  const filtered = [];
  for (const r of recs) {
    if (isSensitive(r.text)) {
      filtered.push(r);
      continue;
    }
    kept.push({ ...r, text: sanitizeText(r.text) });
  }
  return { kept, filtered };
}

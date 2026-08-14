const PRIVACY_PATTERNS = [
  /\b1[3-9]\d{9}\b/g,
  /\b\d{11}\b/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b\d{17}[\dXx]\b/g,
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  /[\u4e00-\u9fff]{1,5}(?:省|市|区|县|镇|村|路|街|号|栋|楼|单元|室)/g,
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
];

const SENSITIVE_KEYWORDS = [
  '身份证', '银行卡', '手机号', '电话号码', '住址', '家庭住址',
  '密码', '验证码', '账号密码', '银行卡号', '身份证号',
  '裸照', '裸聊', '色情', '黄色视频', 'AV', 'a片', '黄片', '自拍',
  '约炮', '卖淫', '嫖娼', '援助交际', '包养',
  '毒品', '冰毒', '海洛因', '大麻', '摇头丸',
  '枪支', '弹药', '爆炸物', '自制炸弹',
  '赌博', '博彩', '赌球', '六合彩',
  '诈骗', '传销', '洗钱', '刷单兼职',
  '自杀', '自残',
];

const PLACEHOLDER = '[内容已过滤]';

export function isSensitive(text) {
  if (!text) return false;
  for (const kw of SENSITIVE_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  for (const re of PRIVACY_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

export function sanitizeText(text) {
  if (!text) return text;
  let out = text;
  for (const re of PRIVACY_PATTERNS) {
    out = out.replace(re, PLACEHOLDER);
  }
  return out;
}

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

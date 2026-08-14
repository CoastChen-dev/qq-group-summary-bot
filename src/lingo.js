import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LINGO_FILE = path.resolve(__dirname, '..', 'data', 'lingo.json');

export class LingoStore {
  constructor(filePath = DEFAULT_LINGO_FILE) {
    this.filePath = filePath;
    this.entries = new Map();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.entries = new Map(Object.entries(data));
      }
    } catch (e) {
      log(`[lingo] 加载词典失败: ${e.message}`);
    }
  }

  _save() {
    try {
      const obj = Object.fromEntries(this.entries);
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      log(`[lingo] 保存词典失败: ${e.message}`);
    }
  }

  lookup(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();
    for (const [key, value] of this.entries) {
      if (lower.includes(String(key).toLowerCase())) {
        return { term: key, meaning: value };
      }
    }
    return null;
  }

  learn(term, meaning) {
    if (!term) return;
    this.entries.set(String(term).trim(), String(meaning).trim());
    this._save();
    log(`[lingo] 已学习新词条: ${term}`);
  }

  delete(term) {
    if (this.entries.delete(String(term))) {
      this._save();
      return true;
    }
    return false;
  }

  size() {
    return this.entries.size;
  }
}

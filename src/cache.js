import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_FILE = path.resolve(__dirname, '..', 'data', 'knowledge_cache.json');

export class KnowledgeCache {
  constructor(filePath = DEFAULT_CACHE_FILE, { ttlHours = 168 } = {}) {
    this.filePath = filePath;
    this.ttlMs = ttlHours * 3600 * 1000;
    this.store = new Map();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.store = new Map(Object.entries(data));
      }
    } catch (e) {
      log(`[cache] 加载缓存失败: ${e.message}`);
    }
  }

  _save() {
    try {
      const obj = Object.fromEntries(this.store);
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      log(`[cache] 保存缓存失败: ${e.message}`);
    }
  }

  _normalizeKey(key) {
    return String(key).toLowerCase().trim();
  }

  get(key) {
    const k = this._normalizeKey(key);
    const entry = this.store.get(k);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.store.delete(k);
      return null;
    }
    return entry;
  }

  set(key, value) {
    const k = this._normalizeKey(key);
    this.store.set(k, {
      ...value,
      cachedAt: Date.now(),
    });
    this._save();
  }

  hit(key) {
    const k = this._normalizeKey(key);
    const entry = this.store.get(k);
    if (!entry) return 0;
    // 命中只计次数，不刷新 cachedAt，避免热点问题被无限续期
    entry.hits = (entry.hits || 0) + 1;
    return entry.hits;
  }

  size() {
    return this.store.size;
  }
}

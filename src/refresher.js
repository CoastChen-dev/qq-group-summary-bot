import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

const DEFAULT_BASES = [
  'https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel',
  'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel',
];

// 定期从 ArknightsGameData 更新本地数据库文件。
// 支持 ETag 版本比对（未变化跳过下载）、多镜像容错、原子写入（临时文件 → rename）。
export class DataRefresher {
  constructor(dataDir, cfg = {}) {
    this.dataDir = dataDir;
    this.bases = cfg.baseUrl ? [cfg.baseUrl] : (cfg.baseUrls || DEFAULT_BASES);
    this.etagFile = path.join(dataDir, '.etags.json');
    this.etags = this._loadEtags();
    this.files = [
      {
        name: 'character_table.json',
        desc: '干员表',
        validate: (buf) => {
          const j = JSON.parse(buf.toString('utf8'));
          const dict = j.characters || j;
          let cnt = 0;
          for (const v of Object.values(dict)) if (v && typeof v === 'object' && v.name) cnt++;
          if (cnt < 500) throw new Error(`干员数量异常（${cnt} < 500）`);
        },
      },
      {
        name: 'handbook_info_table.json',
        desc: '干员档案',
        validate: (buf) => {
          const j = JSON.parse(buf.toString('utf8'));
          const n = Object.keys(j.handbookDict || {}).length;
          if (n < 100) throw new Error(`档案数量异常（${n} < 100）`);
        },
      },
      {
        name: 'roguelike_topic_table.json',
        desc: '肉鸽藏品',
        validate: (buf) => {
          const j = JSON.parse(buf.toString('utf8'));
          let cnt = 0;
          const walk = (o) => {
            if (!o || typeof o !== 'object') return;
            for (const v of Object.values(o)) {
              if (v && typeof v === 'object') {
                if (v.type === 'RELIC' && v.name) cnt++;
                else walk(v);
              }
            }
          };
          walk(j);
          if (cnt < 500) throw new Error(`藏品数量异常（${cnt} < 500）`);
        },
      },
      {
        name: 'gacha_table.json',
        desc: '卡池表',
        validate: (buf) => {
          const j = JSON.parse(buf.toString('utf8'));
          const n = (j.gachaPoolClient || []).length;
          if (n < 10) throw new Error(`卡池数量异常（${n} < 10）`);
        },
      },
    ];
  }

  _loadEtags() {
    try {
      if (fs.existsSync(this.etagFile)) {
        return JSON.parse(fs.readFileSync(this.etagFile, 'utf8'));
      }
    } catch { /* 忽略 */ }
    return {};
  }

  _saveEtags() {
    try {
      fs.writeFileSync(this.etagFile, JSON.stringify(this.etags));
    } catch { /* 忽略 */ }
  }

  async _download(file) {
    const tmp = path.join(this.dataDir, `${file.name}.tmp`);
    const final = path.join(this.dataDir, file.name);
    const prevEtag = this.etags[file.name];
    let lastErr = null;

    for (const base of this.bases) {
      const url = `${base}/${file.name}`;
      try {
        const headers = { 'User-Agent': 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)' };
        if (prevEtag) headers['If-None-Match'] = prevEtag;
        const resp = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(90000),
        });

        // 304：内容未变化，跳过下载
        if (resp.status === 304) {
          return { changed: false, size: 0 };
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const newEtag = resp.headers.get('etag') || '';
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 1024) throw new Error(`文件过小 (${buf.length}B)`);
        if (buf[0] !== 0x7b /* '{' */) throw new Error('内容不是 JSON 对象');

        // 结构校验（防止上游数据损坏污染本地库）
        if (file.validate) file.validate(buf);

        // 原子替换：写临时文件 → 备份旧文件 → rename
        fs.writeFileSync(tmp, buf);
        if (fs.existsSync(final)) {
          try { fs.copyFileSync(final, `${final}.bak`); } catch { /* 备份失败不阻塞 */ }
        }
        fs.renameSync(tmp, final);
        if (newEtag) this.etags[file.name] = newEtag;
        return { changed: true, size: buf.length };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('所有镜像源均失败');
  }

  // 返回 { updated: string[], unchanged: string[], failed: string[] }
  async refresh() {
    const updated = [];
    const unchanged = [];
    const failed = [];
    for (const f of this.files) {
      try {
        const r = await this._download(f);
        if (r.changed) {
          updated.push(f.desc);
          log(`[refresh] ${f.name} 已更新 (${Math.round(r.size / 1024)}KB)`);
        } else {
          unchanged.push(f.desc);
        }
      } catch (e) {
        failed.push(`${f.desc}: ${e.message}`);
        log(`[refresh] ${f.name} 更新失败: ${e.message}`);
      }
    }
    this._saveEtags();
    return { updated, unchanged, failed };
  }
}

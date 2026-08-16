import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

const DEFAULT_BASES = [
  'https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel',
  'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel',
];

// 定期从 ArknightsGameData 更新本地数据库文件（原子写入：临时文件 → rename）
export class DataRefresher {
  constructor(dataDir, cfg = {}) {
    this.dataDir = dataDir;
    this.bases = cfg.baseUrl ? [cfg.baseUrl] : (cfg.baseUrls || DEFAULT_BASES);
    this.files = [
      { name: 'character_table.json', desc: '干员表' },
      { name: 'handbook_info_table.json', desc: '干员档案' },
      { name: 'roguelike_topic_table.json', desc: '肉鸽藏品' },
      { name: 'gacha_table.json', desc: '卡池表' },
    ];
  }

  async _download(file) {
    const tmp = path.join(this.dataDir, `${file.name}.tmp`);
    const final = path.join(this.dataDir, file.name);
    let lastErr = null;

    // 依次尝试多个镜像源
    for (const base of this.bases) {
      const url = `${base}/${file.name}`;
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'PRTS-AI-Bot/1.0 (QQ Group Chat Bot; contact: local)' },
          signal: AbortSignal.timeout(90000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());

        if (buf.length < 1024) throw new Error(`文件过小 (${buf.length}B)`);
        if (buf[0] !== 0x7b /* '{' */) throw new Error('内容不是 JSON 对象');

        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, final);
        return buf.length;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('所有镜像源均失败');
  }

  // 下载所有文件，返回 { updated: string[], failed: {name, reason}[] }
  async refresh() {
    const updated = [];
    const failed = [];
    for (const f of this.files) {
      try {
        const size = await this._download(f);
        updated.push(`${f.desc}(${Math.round(size / 1024)}KB)`);
        log(`[refresh] ${f.name} 更新成功 (${Math.round(size / 1024)}KB)`);
      } catch (e) {
        failed.push(`${f.desc}: ${e.message}`);
        log(`[refresh] ${f.name} 更新失败: ${e.message}`);
      }
    }
    return { updated, failed };
  }
}

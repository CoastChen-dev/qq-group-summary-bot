import http from 'node:http';
import { log } from './logger.js';

// 简单的 Web 管理面板（Node 内置 http，零依赖）
// API: /api/status /api/lingo /api/refresh /api/config
export class WebUI {
  constructor(cfg = {}) {
    this.port = cfg.port ?? 5210;
    this.host = cfg.host ?? '127.0.0.1';
    this.token = cfg.token ?? '';
    this.server = null;
    this.ctx = null;
  }

  start(ctx) {
    this.ctx = ctx;
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => {
      try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e.message || e) })); } catch { /* 忽略 */ }
    }));
    this.server.listen(this.port, this.host, () => {
      log(`[webui] 管理面板已启动: http://${this.host}:${this.port}${this.token ? ' （需 token）' : ''}`);
    });
  }

  _authorized(req) {
    if (!this.token) return true;
    const url = new URL(req.url, 'http://localhost');
    const h = req.headers['authorization'] || '';
    const q = url.searchParams.get('token') || '';
    return h === `Bearer ${this.token}` || q === this.token;
  }

  async _body(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    });
  }

  _json(res, obj) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  _maskedConfig() {
    const cfg = this.ctx.getConfig();
    const masked = JSON.parse(JSON.stringify(cfg));
    if (masked.llm?.apiKey) masked.llm.apiKey = masked.llm.apiKey.slice(0, 6) + '…' + masked.llm.apiKey.slice(-4);
    if (masked.napcat?.accessToken) masked.napcat.accessToken = '***';
    return masked;
  }

  async _handle(req, res) {
    if (!this._authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method || 'GET';

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this._html());
      return;
    }

    if (p === '/api/status') {
      return this._json(res, this.ctx.getStatus());
    }

    if (p === '/api/lingo') {
      if (m === 'GET') {
        const entries = [...this.ctx.getLingo().entries.entries()].map(([term, meaning]) => ({ term, meaning }));
        return this._json(res, { entries });
      }
      if (m === 'POST') {
        const body = await this._body(req);
        if (body.action === 'delete') {
          const ok = this.ctx.getLingo().delete(String(body.term || ''));
          return this._json(res, { ok, term: body.term });
        }
        if (body.term && body.meaning) {
          this.ctx.getLingo().learn(String(body.term), String(body.meaning));
          return this._json(res, { ok: true, term: body.term });
        }
        return this._json(res, { ok: false, error: '缺少 term 或 meaning' });
      }
    }

    if (p === '/api/refresh' && m === 'POST') {
      const result = await this.ctx.refreshData();
      return this._json(res, { ok: true, result });
    }

    if (p === '/api/config') {
      return this._json(res, this._maskedConfig());
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  _html() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PRTS Bot 管理面板</title>
<style>
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #222; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .card { background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card h2 { font-size: 15px; margin: 0 0 10px; border-left: 3px solid #4a6cf7; padding-left: 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; }
  .stat { flex: 1; min-width: 110px; background: #f0f3ff; border-radius: 8px; padding: 10px; text-align: center; }
  .stat b { display: block; font-size: 20px; color: #4a6cf7; }
  .stat span { font-size: 12px; color: #666; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left; }
  .term { font-weight: 600; }
  input, button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #ccc; }
  button { background: #4a6cf7; color: #fff; border: none; cursor: pointer; }
  button.danger { background: #e5484d; }
  button:hover { opacity: .9; }
  .muted { color: #888; font-size: 12px; }
  pre { background: #f7f8fa; border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #222; color: #fff; padding: 10px 16px; border-radius: 8px; opacity: 0; transition: opacity .3s; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="wrap">
  <h1>PRTS Bot 管理面板</h1>

  <div class="card">
    <h2>运行状态</h2>
    <div class="row" id="status"></div>
  </div>

  <div class="card">
    <h2>数据更新</h2>
    <button onclick="doRefresh()">立即刷新本地数据</button>
    <span class="muted" id="refreshNote"></span>
  </div>

  <div class="card">
    <h2>本地词典管理 <span class="muted" id="lingoCount"></span></h2>
    <div class="row" style="margin-bottom:10px;">
      <input id="newTerm" placeholder="词条（如：轮椅轴）" style="flex:1;">
      <input id="newMeaning" placeholder="释义" style="flex:2;">
      <button onclick="addLingo()">添加</button>
    </div>
    <table><thead><tr><th>词条</th><th>释义</th><th style="width:60px;"></th></tr></thead><tbody id="lingoTbody"></tbody></table>
  </div>

  <div class="card">
    <h2>当前配置（密钥已脱敏）</h2>
    <pre id="configView">加载中…</pre>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function loadStatus() {
  const s = await api('/api/status');
  $('status').innerHTML = [
    stat('WS 连接', s.wsConnected ? '在线' : '离线'),
    stat('机器人 QQ', s.selfId || '-'),
    stat('干员数', s.operators),
    stat('藏品数', s.relics),
    stat('卡池数', s.pools),
    stat('消息数', s.messages),
    stat('词典数', s.lingoCount),
    stat('运行时长', s.uptime),
  ].join('');
}
function stat(label, val) { return '<div class="stat"><b>' + val + '</b><span>' + label + '</span></div>'; }
async function loadLingo() {
  const d = await api('/api/lingo');
  $('lingoCount').textContent = '（共 ' + d.entries.length + ' 条）';
  $('lingoTbody').innerHTML = d.entries.map((e) =>
    '<tr><td class="term">' + esc(e.term) + '</td><td>' + esc(e.meaning) + '</td><td><button class="danger" onclick="delLingo(\\'' + esc(e.term).replace(/'/g, "\\\\'") + '\\')">删除</button></td></tr>'
  ).join('');
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function addLingo() {
  const term = $('newTerm').value.trim(), meaning = $('newMeaning').value.trim();
  if (!term || !meaning) return toast('请填写词条和释义');
  await api('/api/lingo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ term, meaning }) });
  $('newTerm').value = ''; $('newMeaning').value = '';
  toast('已添加：' + term);
  loadLingo();
}
async function delLingo(term) {
  await api('/api/lingo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', term }) });
  toast('已删除：' + term);
  loadLingo();
}
async function doRefresh() {
  $('refreshNote').textContent = '更新中…';
  try {
    const r = await api('/api/refresh', { method: 'POST' });
    toast('刷新完成');
    $('refreshNote').textContent = r.result;
    loadStatus();
  } catch (e) {
    $('refreshNote').textContent = '失败：' + e.message;
  }
}
async function loadConfig() {
  const c = await api('/api/config');
  $('configView').textContent = JSON.stringify(c, null, 2);
}
loadStatus(); loadLingo(); loadConfig();
setInterval(loadStatus, 10000);
</script>
</body>
</html>`;
  }
}

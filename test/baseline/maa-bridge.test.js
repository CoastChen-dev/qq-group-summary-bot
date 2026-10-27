/**
 * 基线：MaaBridge 的 HTTP 客户端面（不拉起 worker，用本地 stub 服务）。
 *
 * 锁定目标：/status、/task、/job/:id、/stop 的请求形状与错误语义；token 头；
 * busy（409）与未知任务（404）能带出 status，供插件区分提示。
 * 真实 worker（Python + MaaCore）由 tools/maa_bridge/worker.py 提供，另做手工冒烟。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { MaaBridge, MaaBridgeError } from '../../src/core/platform/maa.js';
import { silenceLog } from '../helpers.js';

after(silenceLog());

let server;
let baseUrl;
const seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, token: req.headers['x-maa-token'], body });
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.headers['x-maa-token'] !== 'tok') return send(401, { ok: false, error: 'bad token' });
      if (req.method === 'GET' && req.url === '/status') {
        return send(200, { ok: true, version: 'v6.20.1', connected: true, running: false, job: null });
      }
      if (req.method === 'POST' && req.url === '/task') {
        if (body.includes('"type":"Busy"')) return send(409, { ok: false, error: 'busy' });
        return send(200, { ok: true, job_id: 'job1' });
      }
      if (req.method === 'GET' && req.url === '/job/job1') {
        return send(200, { ok: true, id: 'job1', state: 'done', elapsed: 3, drops: { 龙门币: 5 }, chains: ['Fight'], error: '' });
      }
      if (req.method === 'GET' && req.url === '/screenshot') {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        return res.end(png);
      }
      if (req.method === 'GET' && req.url === '/job/nope') return send(404, { ok: false, error: 'unknown job' });
      if (req.method === 'POST' && req.url === '/stop') return send(200, { ok: true });
      return send(404, { ok: false, error: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

describe('MaaBridge HTTP 客户端', () => {
  it('status / submit / job / stop 走通，且带 token 头', async () => {
    const bridge = new MaaBridge({ baseUrl, token: 'tok', autoSpawn: false });
    await bridge.start();
    const s = await bridge.status();
    assert.equal(s.version, 'v6.20.1');
    assert.equal(s.connected, true);
    const sub = await bridge.submit('Fight', { stage: 'CE-6', times: 5 });
    assert.equal(sub.job_id, 'job1');
    const job = await bridge.job('job1');
    assert.equal(job.state, 'done');
    assert.deepEqual(job.drops, { 龙门币: 5 });
    await bridge.stop();
    assert.ok(seen.every((x) => x.token === 'tok'));
    const taskReq = seen.find((x) => x.url === '/task');
    assert.deepEqual(JSON.parse(taskReq.body), { type: 'Fight', params: { stage: 'CE-6', times: 5 } });
    bridge.close();
  });

  it('busy（409）与未知任务（404）：错误里保留 status，便于插件区分提示', async () => {
    const bridge = new MaaBridge({ baseUrl, token: 'tok', autoSpawn: false });
    await bridge.start();
    await assert.rejects(() => bridge.submit('Busy', {}), (e) => {
      assert.ok(e instanceof MaaBridgeError);
      assert.equal(e.status, 409);
      assert.match(e.message, /busy/);
      return true;
    });
    await assert.rejects(() => bridge.job('nope'), (e) => e.status === 404);
    bridge.close();
  });

  it('submitMany：任务链按 {tasks:[{type,params}]} 提交', async () => {
    const bridge = new MaaBridge({ baseUrl, token: 'tok', autoSpawn: false });
    await bridge.start();
    const r = await bridge.submitMany([
      { type: 'StartUp', params: { client_type: 'Bilibili' } },
      { type: 'Award', params: {} },
    ]);
    assert.equal(r.job_id, 'job1');
    const req = seen.filter((x) => x.url === '/task').at(-1);
    assert.deepEqual(JSON.parse(req.body), {
      tasks: [{ type: 'StartUp', params: { client_type: 'Bilibili' } }, { type: 'Award', params: {} }],
    });
    bridge.close();
  });

  it('screenshot：走二进制路径返回 PNG Buffer', async () => {
    const bridge = new MaaBridge({ baseUrl, token: 'tok', autoSpawn: false });
    await bridge.start();
    const png = await bridge.screenshot();
    assert.ok(Buffer.isBuffer(png));
    assert.deepEqual(png.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    bridge.close();
  });

  it('未启动时请求直接报错（不静默）', async () => {
    const bridge = new MaaBridge({ autoSpawn: false }); // 无 baseUrl、未 start
    await assert.rejects(() => bridge.status(), /未启动/);
  });
});

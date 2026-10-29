/**
 * MAA 桥客户端（2026-10）：以子进程方式拉起 tools/maa_bridge/worker.py，通过本机 HTTP 驱动
 * MaaCore（明日方舟自动化）。bot 侧不直接 FFI MaaCore：回调与缓冲区跨语言编组太脆，官方只维护
 * Python/C# 绑定。
 *
 * 生命周期：start() 起 worker（等它打印 MAA_BRIDGE_PORT）→ 轮询 /status 就绪；close() 杀进程。
 * 安全：worker 只监听 127.0.0.1，并用随机 token（X-Maa-Token）鉴权，防本机其他程序操作游戏。
 *
 * 对外方法：start / status / submit / job / stop / close。
 * 实例化点：core/runtime.js createApp（config.maa.enabled 时构造，由 maa 插件 hooks 启停）。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 本机 HTTP 请求失败（保留 status，便于调用方区分 busy/未连接） */
export class MaaBridgeError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'MaaBridgeError';
    this.status = status;
  }
}

export class MaaBridge {
  /**
   * @param {Object} opts - 配置（runtime 由 config.maa 派生）
   * @param {string} opts.maaPath - MAA 安装目录（含 MaaCore.dll 与 resource/）
   * @param {string} [opts.python='python'] - Python 解释器
   * @param {string} [opts.adbPath='adb.exe'] - adb 可执行文件
   * @param {string} [opts.adbAddress='127.0.0.1:5555'] - 设备地址
   * @param {string} [opts.connectConfig='General'] - MAA 连接配置名（如 MuMuEmulator12）
   * @param {string} [opts.workerScript] - worker.py 路径（默认随仓库）
   * @param {number} [opts.port=0] - worker 端口（0 = 系统分配）
   * @param {string} [opts.token] - 鉴权 token（默认随机）
   * @param {boolean} [opts.autoSpawn=true] - false 时只连已有 worker（测试用）
   * @param {string} [opts.baseUrl=''] - 已有 worker 的地址（配了就不 spawn）
   * @param {number} [opts.timeoutMinutes=60] - 单个任务超时（worker 侧强制停止）
   */
  constructor({
    maaPath = '', python = 'python', adbPath = 'adb.exe', adbAddress = '127.0.0.1:5555',
    connectConfig = 'General', workerScript = '', port = 0, token = '', autoSpawn = true,
    baseUrl = '', timeoutMinutes = 60, requestTimeoutMs = 15000,
  } = {}) {
    this.maaPath = maaPath;
    this.python = python;
    this.adbPath = adbPath;
    this.adbAddress = adbAddress;
    this.connectConfig = connectConfig;
    this.workerScript = workerScript || path.join(root, 'tools', 'maa_bridge', 'worker.py');
    this.port = Number(port) || 0;
    this.token = token || crypto.randomBytes(8).toString('hex');
    this.autoSpawn = autoSpawn;
    this.baseUrl = baseUrl;
    this.timeoutMinutes = timeoutMinutes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.started = false;
    this._stderr = '';
    this._exited = false;
    this._starting = null; // start() 并发去重（自动重启时避免重复 spawn）
  }

  /** 启动 worker 并等就绪（反复调用幂等；并发调用复用同一个启动 Promise） */
  async start() {
    if (this.started) return;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      try {
        this._exited = false;
        this._stderr = '';
        if (!this.baseUrl) {
          if (!this.autoSpawn) throw new MaaBridgeError('maa bridge: 未配置 baseUrl 且 autoSpawn=false');
          if (!this.maaPath) throw new MaaBridgeError('maa bridge: 未配置 maaPath');
          await this._spawn();
        }
        await this._waitReady();
        this.started = true;
      } finally {
        this._starting = null;
      }
    })();
    return this._starting;
  }

  /**
   * 确保桥可用：worker 运行中崩溃（子进程 exit）后，下一次指令会自动重新拉起。
   * @returns {Promise<void>} 就绪即 resolve；重启失败按 start() 的异常抛出
   */
  async ensureReady() {
    if (this.started && this.baseUrl) return;
    await this.start();
  }

  /** 拉起 worker，解析 MAA_BRIDGE_PORT 行拿端口 */
  _spawn() {
    return new Promise((resolve, reject) => {
      const args = [
        '-u', this.workerScript,
        '--maa-path', this.maaPath,
        '--adb', this.adbPath,
        '--address', this.adbAddress,
        '--config', this.connectConfig,
        '--port', String(this.port),
        '--token', this.token,
        '--timeout-min', String(this.timeoutMinutes),
      ];
      log(`[maa] 启动 worker: ${this.python} ${this.workerScript}`);
      this.child = spawn(this.python, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const deadline = Date.now() + 25000;
      this.child.stdout.on('data', (d) => {
        const m = String(d).match(/MAA_BRIDGE_PORT=(\d+)/);
        if (m && !this.port) this.port = Number(m[1]);
        if (this.port && !this.baseUrl) this.baseUrl = `http://127.0.0.1:${this.port}`;
        if (this.baseUrl) resolve();
      });
      this.child.stderr.on('data', (d) => { this._stderr = (this._stderr + String(d)).slice(-4000); });
      this.child.on('error', (e) => { this._exited = true; reject(new MaaBridgeError(`maa worker 启动失败: ${e.message}`)); });
      this.child.on('exit', (code) => this._onChildExit(code, reject));
      const tick = () => {
        if (this.baseUrl) return; // 已由 stdout 解析
        if (this._exited) return; // reject 已在 exit/error 里
        if (Date.now() > deadline) {
          reject(new MaaBridgeError(`maa worker 启动超时（25s）：${this._stderr.slice(-400)}`));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /**
   * 子进程退出处理：初始启动阶段失败 → reject；运行中崩溃 → 复位 started/baseUrl，
   * 下一次 ensureReady()/start() 自动重启（2026-10 修复「worker 挂了就永久失效」）。
   * @param {number|null} code - 退出码
   * @param {Function|null} reject - 初始启动 Promise 的 reject（已就绪后传 null）
   * @returns {void}
   */
  _onChildExit(code, reject = null) {
    this._exited = true;
    this.child = null;
    if (!this.started) {
      if (typeof reject === 'function') {
        reject(new MaaBridgeError(`maa worker 退出 (${code}): ${this._stderr.slice(-400)}`));
      }
      return;
    }
    this.started = false;
    this.baseUrl = '';
    this._starting = null;
    log(`[maa] worker 退出 (${code})，下次指令将自动重启`);
  }

  /** 轮询 /status 直到 ok（worker 加载资源要几秒） */
  async _waitReady(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      try {
        await this.status();
        return;
      } catch (e) {
        last = e.message;
        if (this._exited) throw new MaaBridgeError(`maa worker 已退出：${last}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new MaaBridgeError(`maa bridge 未就绪（${last}）`);
  }

  async _req(method, apiPath, body) {
    if (!this.baseUrl) throw new MaaBridgeError('maa bridge 未启动');
    let res;
    try {
      res = await fetch(`${this.baseUrl}${apiPath}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { 'X-Maa-Token': this.token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new MaaBridgeError(`maa bridge 请求失败: ${e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new MaaBridgeError(data.error || `maa bridge HTTP ${res.status}`, res.status);
    }
    return data;
  }

  /** 运行状态快照 {version, connected, running, job, last_error} */
  status() {
    return this._req('GET', '/status');
  }

  /** 提交任务 {type, params} → {job_id}；已有任务在跑时抛 status=409 */
  submit(type, params = {}) {
    return this._req('POST', '/task', { type, params });
  }

  /**
   * 提交任务链（MAA 顺序执行，全部完成才触发 AllTasksCompleted）。
   * @param {Array<{type: string, params?: Object}>} tasks - 任务数组（如日常一条龙）
   * @param {number} [timeoutMinutes] - 本任务的超时（覆盖 worker 默认；肉鸽/生息这类长任务用）
   * @returns {Promise<{job_id: string}>} 任务句柄
   */
  submitMany(tasks, timeoutMinutes) {
    const body = { tasks };
    if (timeoutMinutes) body.timeout_minutes = timeoutMinutes;
    return this._req('POST', '/task', body);
  }

  /** 查询任务 {state, elapsed, drops, chains, error, events} */
  job(jobId) {
    return this._req('GET', `/job/${encodeURIComponent(jobId)}`);
  }

  /**
   * 现截一张模拟器画面（PNG）。
   * @returns {Promise<Buffer>} PNG 字节
   * 副作用：worker 调 AsstAsyncScreencap + AsstGetImage；任务运行中可能失败（抛 status=503）
   */
  async screenshot() {
    if (!this.baseUrl) throw new MaaBridgeError('maa bridge 未启动');
    let res;
    try {
      res = await fetch(`${this.baseUrl}/screenshot`, {
        headers: this.token ? { 'X-Maa-Token': this.token } : {},
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new MaaBridgeError(`maa 截图请求失败: ${e.message}`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new MaaBridgeError(data.error || `maa 截图 HTTP ${res.status}`, res.status);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new MaaBridgeError('maa 截图返回空');
    return buf;
  }

  /** 停止当前任务 */
  stop() {
    return this._req('POST', '/stop', {});
  }

  /** 重新 adb 连接 */
  connect() {
    return this._req('POST', '/connect', {});
  }

  /** 关停 worker（bot 退出时调用） */
  close() {
    this.started = false;
    if (this.child) {
      try { this.child.kill(); } catch { /* 忽略 */ }
      this.child = null;
    }
  }
}

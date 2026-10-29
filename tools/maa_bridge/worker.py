#!/usr/bin/env python3
"""MAA bridge：把 MaaCore 包成一个本机 HTTP 小服务，供 QQ bot 下指令、收结果。

为什么不直接在 Node 里 FFI：MaaCore 的 C ABI 需要跨语言传回调与缓冲区，官方只维护
Python/C# 绑定；这里直接 import MAA 自带的 `Python/asst`（不复制其代码，随 MAA 升级），
bot 侧只跟 HTTP/JSON 打交道。

接口（全部只监听 127.0.0.1，非空 --token 时要求 X-Maa-Token 头）：
  GET  /status          -> {ok, version, connected, running, job}
  POST /task            -> {ok, job_id}     body: {type, params}；已有任务在跑时 409。
                           设备未连接时先返回 job（state=launching），后台按需拉起模拟器、
                           连上 adb 后再提交 MAA 任务（2026-10）
  GET  /job/<id>        -> {state, elapsed, drops, chains, error, events}
  GET  /screenshot      -> image/png（当前模拟器画面，MaaCore 现截）
  POST /stop            -> {ok}
  POST /connect         -> {ok, connected}  重新 adb 连接

启动时向 stdout 打印 `MAA_BRIDGE_PORT=<port>`（--port 0 时由系统分配），bot 据此拿端口。
"""
import argparse
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

STATE_LOCK = threading.Lock()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--maa-path', required=True, help='MAA 安装目录（含 MaaCore.dll 与 resource/）')
    ap.add_argument('--python-path', default='', help='asst 绑定目录（默认 <maa-path>/Python）')
    ap.add_argument('--adb', default='adb.exe')
    ap.add_argument('--address', default='127.0.0.1:5555')
    ap.add_argument('--config', default='General')
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--token', default='')
    ap.add_argument('--timeout-min', type=int, default=60)
    ap.add_argument('--emulator-cmd', default='', help='模拟器启动命令（JSON 数组；缺省自动探测 adb 同目录的 MuMuManager.exe）')
    ap.add_argument('--emulator-wait', type=int, default=120, help='启动模拟器后等待 adb 连上的秒数')
    args = ap.parse_args()

    sys.path.insert(0, args.python_path or os.path.join(args.maa_path, 'Python'))
    from asst.asst import Asst
    from asst.utils import Message

    # 模拟器自动启动（2026-10）：--emulator-cmd 优先（JSON 数组）；否则自动探测 adb 同目录的
    # MuMuManager.exe（MuMu 12 用 `control -v 0 launch`）。只在 /task 需要连接时启动，不在
    # worker 启动时拉起——避免 bot 重启就把模拟器/游戏一并拉起来。
    emulator_cmd = []
    if args.emulator_cmd:
        try:
            parsed = json.loads(args.emulator_cmd)
            if isinstance(parsed, list) and parsed and all(isinstance(x, str) for x in parsed):
                emulator_cmd = parsed
        except Exception:
            print('[maa-bridge] --emulator-cmd 不是合法 JSON 数组，已忽略', file=sys.stderr)
    if not emulator_cmd:
        mgr = os.path.join(os.path.dirname(os.path.abspath(args.adb)), 'MuMuManager.exe')
        if os.path.isfile(mgr):
            emulator_cmd = [mgr, 'control', '-v', '0', 'launch']

    state = {
        'connected': False,
        'version': '',
        'job': None,          # 当前任务
        'jobs': {},           # id -> 任务（最多保留 20 条）
        'lock': STATE_LOCK,
        'timeout': max(1, args.timeout_min) * 60,
        'emulator_configured': bool(emulator_cmd),
        'last_error': '',
    }

    def job_public(job):
        if not job:
            return None
        return {
            'id': job['id'],
            'type': job['type'],
            'tasks': job.get('tasks') or [{'type': job['type'], 'params': {}}],
            'state': job['state'],
            'elapsed': round(time.time() - job['started'], 1),
            'drops': job['drops'],
            'chains': job['chains'],
            'error': job['error'],
            'events': job['events'][-30:],
        }

    def finish(job, state_name, error=''):
        # launching 阶段也可能失败（模拟器起不来/连接超时），同样要落终态
        if not job or job['state'] in ('done', 'error', 'stopped'):
            return
        job['state'] = state_name
        job['error'] = error
        job['finished'] = time.time()

    def on_msg(msg, details, _arg):
        try:
            raw = details.decode('utf-8') if isinstance(details, (bytes, bytearray)) else str(details)
            d = json.loads(raw) if raw else {}
        except Exception:
            d = {}
        kind = Message(msg)
        with STATE_LOCK:
            job = state['job']
            if not job:
                return
            if kind == Message.TaskChainStart:
                job['chains'].append(d.get('taskchain') or d.get('name') or '')
            elif kind == Message.TaskChainCompleted:
                pass
            elif kind in (Message.TaskChainError, Message.TaskChainStopped):
                finish(job, 'error' if kind == Message.TaskChainError else 'stopped', raw[:500])
            elif kind == Message.SubTaskExtraInfo:
                what = d.get('what') or ''
                inner = d.get('details') or {}
                if what == 'StageDrops':
                    for st in inner.get('stats') or []:
                        name = st.get('itemName') or st.get('item_name') or ''
                        qty = int(st.get('addQuantity') or st.get('add_quantity') or 0)
                        if name and qty > 0:
                            job['drops'][name] = job['drops'].get(name, 0) + qty
                job['events'].append({'what': what, 'details': inner if what else {}})
            elif kind == Message.AllTasksCompleted:
                finish(job, 'done')

    # 加载核心与资源（失败直接退出，错误写 stderr 供 bot 记录）
    ok = Asst.load(path=args.maa_path)
    if not ok:
        print('MAA bridge: Asst.load 失败（检查 --maa-path）', file=sys.stderr)
        sys.exit(2)
    asst = Asst(callback=Asst.CallBackType(on_msg))
    try:
        state['version'] = str(asst.get_version() or '')
    except Exception:
        state['version'] = ''

    # 截图：MaaCore 只导出 AsstAsyncScreencap / AsstGetImage，asst.py 没包装，直接按 C ABI 调。
    # AsstGetImage 返回 PNG 字节（实测 magic \x89PNG）；缓冲按 24MB 预留，够 4K 截图。
    lib = Asst._Asst__lib
    lib.AsstAsyncScreencap.argtypes = (ctypes.c_void_p, ctypes.c_bool)
    lib.AsstAsyncScreencap.restype = ctypes.c_bool
    lib.AsstGetImage.argtypes = (ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint64)
    lib.AsstGetImage.restype = ctypes.c_uint64
    asst_ptr = asst._Asst__ptr
    SHOT_SIZE = 24 * 1024 * 1024
    shot_buf = (ctypes.c_byte * SHOT_SIZE)()

    def connect():
        with STATE_LOCK:
            if state['connected']:
                return True
            state['last_error'] = ''
        try:
            if asst.connect(args.adb, args.address, args.config):
                state['connected'] = True
                return True
            state['last_error'] = 'adb 连接失败（检查模拟器 / adb 路径 / 地址）；发「maa 唤醒」可自动启动模拟器'
        except Exception as e:
            state['last_error'] = f'连接异常：{e}'
        return False

    def launch_emulator():
        """按配置/自动探测的命令拉起模拟器进程（detached：不阻塞、不接管输出）。"""
        if not emulator_cmd:
            state['last_error'] = '未连接且未配置模拟器启动命令（config.maa.emulatorCommand）'
            return False
        try:
            kwargs = {}
            if os.name == 'nt':
                kwargs['creationflags'] = (
                    getattr(subprocess, 'DETACHED_PROCESS', 0x00000008)
                    | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x00000200)
                )
            subprocess.Popen(emulator_cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, close_fds=True, **kwargs)
            state['last_error'] = '模拟器启动中…'
            return True
        except Exception as e:
            state['last_error'] = f'模拟器启动失败：{e}'
            return False

    def ensure_emulator():
        """连接设备；连不上就拉起模拟器并轮询等待（2026-10：后台未开模拟器时「maa 唤醒」也能用）。"""
        if connect():
            return True
        if not launch_emulator():
            return False
        deadline = time.time() + max(10, args.emulator_wait)
        while time.time() < deadline:
            time.sleep(3)
            if connect():
                return True
        state['last_error'] = f'模拟器启动后 {max(10, args.emulator_wait)}s 内仍未连上（检查 adb 地址与模拟器状态）'
        return False

    def run_task(job, tasks):
        """后台执行：先确保设备（必要时启动模拟器），再向 MaaCore 追加任务并启动。"""
        try:
            if not ensure_emulator():
                finish(job, 'error', state['last_error'] or '连接失败')
                return
            with STATE_LOCK:
                if job['state'] != 'launching':
                    return  # 启动期间被 stop 了
                job['state'] = 'running'
            for t in tasks:
                if asst.append_task(t['type'], t['params']) < 0:
                    raise RuntimeError(f"append_task 失败：{t['type']}")
            if not asst.start():
                raise RuntimeError('AsstStart 失败')
        except Exception as e:
            finish(job, 'error', str(e))

    connect()

    def check_timeout():
        job = state['job']
        if job and job['state'] in ('running', 'launching'):
            limit = job.get('timeout') or state['timeout']
            if time.time() - job['started'] > limit:
                try:
                    asst.stop()
                except Exception:
                    pass
                finish(job, 'error', f'超过 {round(limit / 60)} 分钟，已停止')

    class Handler(BaseHTTPRequestHandler):
        server_version = 'MaaBridge/1.0'

        def log_message(self, fmt, *a):
            print('[maa-bridge] ' + (fmt % a), file=sys.stderr)

        def _auth(self):
            if not args.token:
                return True
            if self.headers.get('X-Maa-Token') == args.token:
                return True
            self._send(401, {'ok': False, 'error': 'bad token'})
            return False

        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            try:
                n = int(self.headers.get('Content-Length') or 0)
                return json.loads(self.rfile.read(n).decode('utf-8')) if n else {}
            except Exception:
                return {}

        def do_GET(self):
            if not self._auth():
                return
            path = urlparse(self.path).path
            if path == '/status':
                with STATE_LOCK:
                    check_timeout()
                    return self._send(200, {
                        'ok': True,
                        'version': state['version'],
                        'connected': state['connected'],
                        'running': bool(state['job'] and state['job']['state'] in ('running', 'launching')),
                        'job': job_public(state['job']),
                        'emulator_configured': state['emulator_configured'],
                        'last_error': state['last_error'],
                    })
            if path.startswith('/job/'):
                jid = path.rsplit('/', 1)[-1]
                with STATE_LOCK:
                    check_timeout()
                    job = state['jobs'].get(jid)
                    if not job:
                        return self._send(404, {'ok': False, 'error': 'unknown job'})
                    return self._send(200, {'ok': True, **job_public(job)})
            if path == '/screenshot':
                if not connect():
                    return self._send(502, {'ok': False, 'error': state['last_error'] or 'connect failed'})
                with STATE_LOCK:
                    captured = bool(lib.AsstAsyncScreencap(asst_ptr, True))
                if not captured:
                    return self._send(503, {'ok': False, 'error': '截图失败（任务运行中或设备无响应）'})
                n = int(lib.AsstGetImage(asst_ptr, shot_buf, SHOT_SIZE))
                if not 0 < n <= SHOT_SIZE:
                    return self._send(503, {'ok': False, 'error': '取图失败'})
                png = bytes(shot_buf)[:n]
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(png)))
                self.end_headers()
                self.wfile.write(png)
                return
            return self._send(404, {'ok': False, 'error': 'not found'})

        def do_POST(self):
            if not self._auth():
                return
            path = urlparse(self.path).path
            if path == '/task':
                body = self._body()
                # 兼容两种形状：单任务 {type, params}，或任务链 {tasks:[{type, params}, ...]}
                raw_tasks = body.get('tasks')
                if raw_tasks is None:
                    raw_tasks = [{'type': body.get('type'), 'params': body.get('params') or {}}]
                if not isinstance(raw_tasks, list) or not raw_tasks:
                    return self._send(400, {'ok': False, 'error': 'missing type'})
                tasks = []
                for item in raw_tasks:
                    if not isinstance(item, dict):
                        return self._send(400, {'ok': False, 'error': 'bad task item'})
                    task_type = str(item.get('type') or '').strip()
                    if not task_type:
                        return self._send(400, {'ok': False, 'error': 'missing type'})
                    params = item.get('params') or {}
                    # MAA 的 StartUp 任务默认不会自己拉起游戏（API 调用时 start_game_enabled 缺省 false，
                    # 实测不传会一直 OCR 桌面/游戏中心直到 50 次重试失败）。这里统一补 true；
                    # 调用方显式传 false 时尊重原值。
                    if task_type == 'StartUp' and 'start_game_enabled' not in params:
                        params['start_game_enabled'] = True
                    tasks.append({'type': task_type, 'params': params})
                with STATE_LOCK:
                    if state['job'] and state['job']['state'] in ('running', 'launching'):
                        return self._send(409, {'ok': False, 'error': 'busy'})
                # 单任务可覆盖超时（肉鸽/生息这类长任务）：body.timeout_minutes
                job_timeout = None
                try:
                    if body.get('timeout_minutes'):
                        job_timeout = max(1, int(body['timeout_minutes'])) * 60
                except (TypeError, ValueError):
                    job_timeout = None
                job = {
                    'id': uuid.uuid4().hex[:12], 'type': tasks[0]['type'], 'tasks': tasks,
                    'started': time.time(), 'state': 'launching', 'drops': {}, 'chains': [],
                    'events': [], 'error': '', 'timeout': job_timeout,
                }
                with STATE_LOCK:
                    state['job'] = job
                    state['jobs'][job['id']] = job
                    if len(state['jobs']) > 20:
                        for old in sorted(state['jobs'], key=lambda k: state['jobs'][k]['started'])[:-20]:
                            state['jobs'].pop(old, None)
                # 立即返回 job：模拟器启动/连接可能要几十秒，不能卡住 HTTP 请求。
                # 后台线程按需拉起模拟器 → adb 连接 → 追加任务 → AsstStart。
                threading.Thread(target=run_task, args=(job, tasks), daemon=True).start()
                return self._send(200, {'ok': True, 'job_id': job['id']})
            if path == '/stop':
                try:
                    asst.stop()
                except Exception:
                    pass
                with STATE_LOCK:
                    finish(state['job'], 'stopped', '手动停止')
                return self._send(200, {'ok': True})
            if path == '/connect':
                with STATE_LOCK:
                    state['connected'] = False
                ok2 = connect()
                return self._send(200 if ok2 else 502, {'ok': ok2, 'connected': state['connected'], 'error': state['last_error']})
            return self._send(404, {'ok': False, 'error': 'not found'})

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    port = server.server_address[1]
    print(f'MAA_BRIDGE_PORT={port}', flush=True)
    print(f'[maa-bridge] ready port={port} maa={args.maa_path} adb={args.adb} addr={args.address}', file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()

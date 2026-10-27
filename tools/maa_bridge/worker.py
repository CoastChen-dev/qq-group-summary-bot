#!/usr/bin/env python3
"""MAA bridge：把 MaaCore 包成一个本机 HTTP 小服务，供 QQ bot 下指令、收结果。

为什么不直接在 Node 里 FFI：MaaCore 的 C ABI 需要跨语言传回调与缓冲区，官方只维护
Python/C# 绑定；这里直接 import MAA 自带的 `Python/asst`（不复制其代码，随 MAA 升级），
bot 侧只跟 HTTP/JSON 打交道。

接口（全部只监听 127.0.0.1，非空 --token 时要求 X-Maa-Token 头）：
  GET  /status          -> {ok, version, connected, running, job}
  POST /task            -> {ok, job_id}     body: {type, params}；已有任务在跑时 409
  GET  /job/<id>        -> {state, elapsed, drops, chains, error, events}
  POST /stop            -> {ok}
  POST /connect         -> {ok, connected}  重新 adb 连接

启动时向 stdout 打印 `MAA_BRIDGE_PORT=<port>`（--port 0 时由系统分配），bot 据此拿端口。
"""
import argparse
import json
import os
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
    args = ap.parse_args()

    sys.path.insert(0, args.python_path or os.path.join(args.maa_path, 'Python'))
    from asst.asst import Asst
    from asst.utils import Message

    state = {
        'connected': False,
        'version': '',
        'job': None,          # 当前任务
        'jobs': {},           # id -> 任务（最多保留 20 条）
        'lock': STATE_LOCK,
        'timeout': max(1, args.timeout_min) * 60,
        'last_error': '',
    }

    def job_public(job):
        if not job:
            return None
        return {
            'id': job['id'],
            'type': job['type'],
            'state': job['state'],
            'elapsed': round(time.time() - job['started'], 1),
            'drops': job['drops'],
            'chains': job['chains'],
            'error': job['error'],
            'events': job['events'][-30:],
        }

    def finish(job, state_name, error=''):
        if not job or job['state'] != 'running':
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

    def connect():
        with STATE_LOCK:
            if state['connected']:
                return True
            state['last_error'] = ''
        try:
            if asst.connect(args.adb, args.address, args.config):
                state['connected'] = True
                return True
            state['last_error'] = 'adb 连接失败（检查模拟器是否启动 / adb 路径 / 地址）'
        except Exception as e:
            state['last_error'] = f'连接异常：{e}'
        return False

    connect()

    def check_timeout():
        job = state['job']
        if job and job['state'] == 'running' and time.time() - job['started'] > state['timeout']:
            try:
                asst.stop()
            except Exception:
                pass
            finish(job, 'error', f'超过 {args.timeout_min} 分钟，已停止')

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
                        'running': bool(state['job'] and state['job']['state'] == 'running'),
                        'job': job_public(state['job']),
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
            return self._send(404, {'ok': False, 'error': 'not found'})

        def do_POST(self):
            if not self._auth():
                return
            path = urlparse(self.path).path
            if path == '/task':
                body = self._body()
                task_type = str(body.get('type') or '').strip()
                params = body.get('params') or {}
                if not task_type:
                    return self._send(400, {'ok': False, 'error': 'missing type'})
                with STATE_LOCK:
                    if state['job'] and state['job']['state'] == 'running':
                        return self._send(409, {'ok': False, 'error': 'busy'})
                if not connect():
                    return self._send(502, {'ok': False, 'error': state['last_error'] or 'connect failed'})
                job = {
                    'id': uuid.uuid4().hex[:12], 'type': task_type, 'params': params,
                    'started': time.time(), 'state': 'running', 'drops': {}, 'chains': [],
                    'events': [], 'error': '',
                }
                with STATE_LOCK:
                    state['job'] = job
                    state['jobs'][job['id']] = job
                    if len(state['jobs']) > 20:
                        for old in sorted(state['jobs'], key=lambda k: state['jobs'][k]['started'])[:-20]:
                            state['jobs'].pop(old, None)
                try:
                    task_id = asst.append_task(task_type, params)
                    if task_id < 0 or not asst.start():
                        raise RuntimeError('AsstStart 失败')
                except Exception as e:
                    finish(job, 'error', str(e))
                    return self._send(500, {'ok': False, 'error': str(e)})
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

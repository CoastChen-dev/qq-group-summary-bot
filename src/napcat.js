import WebSocket from 'ws';
import { log } from './logger.js';

export class NapCatClient {
  constructor(url, opts = {}) {
    this.url = url;
    this.selfId = opts.selfId ?? 0;
    this.accessToken = opts.accessToken ?? '';
    this.reconnectDelay = opts.reconnectDelay ?? 3000;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    this.closed = false;
  }

  onEvent(fn) {
    this.handlers.push(fn);
  }

  connect() {
    const wsUrl = this.accessToken
      ? `${this.url}?access_token=${encodeURIComponent(this.accessToken)}`
      : this.url;
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => {
      log(`[napcat] 已连接 ${wsUrl}`);
      this.emit({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' });
    });
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('error', (e) => console.error('[napcat] ws error:', e.message));
    this.ws.on('close', () => {
      if (this.closed) return;
      log(`[napcat] 连接断开，${this.reconnectDelay / 1000}s 后重连...`);
      setTimeout(() => this.connect(), this.reconnectDelay);
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.post_type) {
      this.emit(msg);
      return;
    }

    if (msg.echo !== undefined && this.pending.has(msg.echo)) {
      const { resolve, reject } = this.pending.get(msg.echo);
      this.pending.delete(msg.echo);
      if (msg.status === 'ok' && msg.retcode === 0) resolve(msg.data ?? {});
      else reject(new Error(`OneBot 返回错误: retcode=${msg.retcode} ${msg.message || ''}`));
      return;
    }

    if (msg.retcode !== undefined || msg.status !== undefined) {
      const first = this.pending.keys().next().value;
      if (first !== undefined) {
        const { resolve, reject } = this.pending.get(first);
        this.pending.delete(first);
        if (msg.status === 'ok' && msg.retcode === 0) resolve(msg.data ?? {});
        else reject(new Error(`OneBot 返回错误: retcode=${msg.retcode} ${msg.message || ''}`));
      }
    }
  }

  emit(event) {
    for (const h of this.handlers) {
      try {
        Promise.resolve(h(event)).catch((e) => console.error(e));
      } catch (e) {
        console.error(e);
      }
    }
  }

  call(action, params = {}) {
    const echo = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(echo, { resolve, reject });
      this.ws.send(JSON.stringify({ action, params, echo }));
      setTimeout(() => {
        if (this.pending.has(echo)) {
          this.pending.delete(echo);
          reject(new Error(`调用 ${action} 超时`));
        }
      }, 15000);
    });
  }

  async getLoginInfo() {
    return this.call('get_login_info');
  }

  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: groupId, message, auto_escape: true });
  }

  sendPrivateMsg(userId, message) {
    return this.call('send_private_msg', { user_id: userId, message, auto_escape: true });
  }

  getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: groupId });
  }

  getGroupMsgHistory(groupId, { messageSeq = 0, count = 50 } = {}) {
    return this.call('get_group_msg_history', { group_id: groupId, message_seq: messageSeq, count });
  }

  close() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}

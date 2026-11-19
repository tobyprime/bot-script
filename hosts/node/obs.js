// hosts/node/obs.js — 观测单一出口（日志/动作/聊天/事件环 + 实时流 + 宿主输出）
//
// 平台侧不落库：环只活在进程内存，断线只能从环续传；进程重启即清空。
// 单调 seq 是 SSE 的 id 与断线续传游标。
const RING_LOG = 500;
const RING_ACTION = 2000;
const RING_CHAT = 200;
const RING_EVENT = 200;

function pushRing(ring, evt, cap) {
  ring.push(evt);
  if (ring.length > cap) ring.shift();
}

export class Observation {
  constructor({ name, outerLog = (level, msg) => console.log(`[${level}] ${msg}`) } = {}) {
    this.name = name ?? 'bot';
    this.logRing = [];
    this.actionRing = [];
    this.chatRing = [];
    this.eventRing = [];
    this._streamSubs = new Set();
    this.seq = 0;
    this._outerLog = outerLog;
  }

  /** 统一出口：打单调 seq → 入对应环 → 广播实时流 */
  publish(type, evt) {
    const seq = ++this.seq;
    const stamped = { seq, type, ...evt };
    if (type === 'log') pushRing(this.logRing, stamped, RING_LOG);
    else if (type === 'action') pushRing(this.actionRing, stamped, RING_ACTION);
    else if (type === 'chat') pushRing(this.chatRing, stamped, RING_CHAT);
    else if (type === 'event') pushRing(this.eventRing, stamped, RING_EVENT);
    this.emitStream(stamped);
    return stamped;
  }

  log(level, msg) {
    const evt = this.publish('log', { ts: Date.now(), level, msg: `[${this.name}] ${msg}` });
    this._outerLog(level, `[${this.name}] ${msg}`);
    return evt;
  }

  subscribe(fn) {
    this._streamSubs.add(fn);
    return () => this._streamSubs.delete(fn);
  }

  emitStream(evt) {
    for (const fn of this._streamSubs) {
      try { fn(evt); } catch { /* 订阅方异常不影响引擎 */ }
    }
  }

  ringSince(type, sinceSeq) {
    const ring = type === 'log' ? this.logRing : type === 'action' ? this.actionRing
      : type === 'event' ? this.eventRing : this.chatRing;
    return ring.filter((e) => e.seq > sinceSeq);
  }
}
